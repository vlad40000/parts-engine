import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseCsvRows } from "@/src/lib/csv";
import { audit, type CacheEdge, type FleetRecord, type HistoryRow, type Snapshot } from "../scripts/fleet-audit/report";
import { readQuery, writeReports } from "../scripts/fleet-audit/run";
import ge from "../scripts/fleet-audit/ge-catalog.json";

let db: PGlite;
let snapshot: Snapshot;

beforeAll(async () => {
  db = new PGlite();
  await migrate(drizzle(db), { migrationsFolder: path.resolve("drizzle") });
  await db.exec(`
    insert into fleet_machines (machine_no, availability, brand, brand_key, model_raw, model_key, serial) values
      ('one','SOLD','GE','GE','GTD42EASJ2WW','GTD42EASJ2WW','TEST-A'),
      ('two','UNCHECKED','GE','GE','GTD42-EASJ2WW','GTD42EASJ2WW',''),
      ('three','SCRAPED','GE','GE','GTD42EASJ2WW','GTD42EASJ2WW','test-a'),
      ('four','SCRAPPED','Other','OTHER','GTD42EASJ2WW','GTD42EASJ2WW','TEST-A'),
      ('6601','BEING REPAIRED','Maytag','MAYTAG','MVW6230HW1','MVW6230HW1','CA1304279'),
      ('6613','PARTS ONLY','Maytag','MAYTAG','MVW6230HW1','MVW6230HW1','CA1304279');
    insert into model_bom_cache (brand_key, model_key, brand_display, model_display, status, row_count)
      values ('GE','GTD42EASJ2WW','GE','GTD42EASJ2WW','found',3);
    insert into model_part_edges (brand_key,model_key,mpn_display,mpn_canonical,source,diagram_id) values
      ('GE','GTD42EASJ2WW','we01x-25535','WE01X25535','fixture','Drum'),
      ('GE','GTD42EASJ2WW','WE03X29897','WE03X29897','fixture','Backsplash, Blower & Motor Assembly'),
      ('GE','GTD42EASJ2WW','WP-TEST','TEST','fixture','Drum');
    insert into machine_part_state (machine_no,mpn_canonical,state,disposition,sold_price) values
      ('one','OLD','pulled','sold',17.00);
    insert into machine_part_disposition_events (machine_no,mpn_canonical,step,next_disposition,repair_machine_no) values
      ('one','EVENTONLY','repair','repair','three');
  `);
  const [fleetSql, historySql, geSql] = await Promise.all([readQuery("fleet"), readQuery("history"), readQuery("ge-cache")]);
  snapshot = await db.transaction(async tx => {
    await tx.exec("set transaction isolation level repeatable read, read only");
    return { audited_at: "fixture", fleet: (await tx.query<FleetRecord>(fleetSql)).rows,
      history: (await tx.query<HistoryRow>(historySql)).rows, ge: (await tx.query<CacheEdge>(geSql)).rows };
  });
}, 30000);
afterAll(async () => { await db?.close(); });

describe("read-only all-status applicability audit", () => {
  it("keeps the record denominator, identity collisions and unknowns visible", () => {
    const result = audit(snapshot);
    expect(result.summary).toMatchObject({ fleet_records: 6, documented_exceptions: 6,
      fully_verified_with_reviewed_evidence: 0, records_after_confirmed_duplicates: 5,
      owner_confirmed_physical_units: 1, exhaustive_physical_unit_count: null, ge_records: 2 });
    const byId = new Map(result.machines.map(r => [r.machine_no, r]));
    expect(byId.get("two")).toMatchObject({ availability: "UNCHECKED", cache_label_match: "labels differ",
      model_bom_found: true, serial_present: false, reviewed_exact_model_source: null, model_spellings: 2 });
    expect(byId.get("one")?.repeated_identity_ids).toEqual(["one", "three"]);
    expect(byId.get("four")).toMatchObject({ availability: "SCRAPPED", model_bom_found: false, reviewed_exact_model_source: null });
    expect(byId.get("three")?.availability).toBe("SCRAPED");
    const placeholders = audit({ ...snapshot, fleet: snapshot.fleet.map(r => ({ ...r, serial: "No Nameplate" })) });
    expect(placeholders.machines[0]).toMatchObject({ serial_present: true, serial_evidence: "placeholder" });
    expect(placeholders.summary).toMatchObject({ blank_serial: 0, nonblank_serial_placeholders: 6, repeated_groups_with_recorded_serial: 0 });
    // Free-text notes in the serial field are not serials, even when they are not on a fixed list.
    for (const note of ["WORE OFF", "Door Locked", "NEW", "NO INFORMATION"]) {
      const noted = audit({ ...snapshot, fleet: snapshot.fleet.map(r => ({ ...r, serial: note })) });
      expect(noted.machines[0].serial_evidence).toBe("placeholder");
    }
    const partial = audit({ ...snapshot, fleet: snapshot.fleet.map(r => ({ ...r, serial: "UNREADABLE 12" })) });
    expect(partial.machines[0].serial_evidence).toBe("recorded");
    expect(audit(snapshot).summary.by_cache_status).toEqual({ found: 3, "no cache row": 3 });
  });

  it("retains the four callout roles only for the matching primary unit", () => {
    const result = audit(snapshot);
    expect(result.maytag.map(r => [r.machine_no, r.role, r.mpn])).toEqual([
      ["6613", "catalog", "W11479877"], ["6613", "supplier_listed", "W11543994"],
      ["6613", "observed", "W11538088"], ["6613", "replacement", "W11543994"]
    ]);
    // Only the physical observation is about 6613. Unverified notes keep a null source rather than a borrowed link.
    expect(result.maytag.map(r => [r.role, r.scope, r.source === null])).toEqual([
      ["catalog", "model MVW6230HW1", false], ["supplier_listed", "model MVW6230HW1", false],
      ["observed", "machine 6613", true], ["replacement", "model MVW6230HW1", true]
    ]);
    expect(result.maytag.every(r => r.factory_identity === "unresolved")).toBe(true);
    expect(result.machines.find(r => r.machine_no === "6601")).toMatchObject({ confirmed_physical_unit: "6613",
      reasons: expect.arrayContaining(["confirmed duplicate of 6613"]) });
    const changedIdentity = audit({ ...snapshot, fleet: snapshot.fleet.map(r =>
      r.machine_no === "6613" ? { ...r, serial: "DIFFERENT" } : r) });
    expect(changedIdentity.maytag).toEqual([]);
    expect(changedIdentity.summary.records_after_confirmed_duplicates).toBe(6);
  });

  it("compares printed identities at every catalog position and keeps directed replacements", () => {
    for (const section of ge.sections) expect(section.positions).toHaveLength(section.publishedRows);
    const { comparison, positions, summary } = audit(snapshot);
    expect(positions).toHaveLength(94);
    expect(comparison.find(r => r.printed_d1 === "WE01X25535")?.oem_matches).toHaveLength(3);
    expect(comparison.find(r => r.mpn_display === "WE03X29897")).toMatchObject({
      outcome: "service replacement", serial_applicability: "unresolved", harvested_identity: "unverified",
      oem_matches: [{ callout: "213", catalog_mpn: "WE12M29", replacement_mpn: "WE03X29897" }]
    });
    expect(comparison.find(r => r.mpn_canonical === "TEST")?.printed_d1).toBe("WPTEST");
    expect(summary.ge_comparison).toEqual({ catalog: 1, "service replacement": 1, "absent from reviewed GE sections": 1 });
    const adjacent = audit({ ...snapshot, ge: snapshot.ge.map(r => ({ ...r, model_display: "GTD42EASJ1WW" })) });
    expect(adjacent.comparison.every(r => r.outcome === "cache identity unresolved" && !r.oem_matches.length)).toBe(true);
  });

  it("keeps a supplier's different number at a drawn position as a competing claim, not a supersession", () => {
    const { positions, comparison, summary } = audit(snapshot);
    const at = (assembly: string, callout: string) => positions.find(p => p.assembly === assembly && p.callout === callout)!;
    expect(at("BACKSPLASH, BLOWER & MOTOR ASSEMBLY", "213")).toMatchObject({ supplier_listed: ["WE03X29897"], supplier_agreement: "replacement" });
    for (const assembly of ["BACKSPLASH, BLOWER & MOTOR ASSEMBLY", "CABINET & TOP PANEL"]) {
      expect(at(assembly, "461")).toMatchObject({ catalog_mpn: "WZ05X0158", replacement_mpn: "WZ5X158D",
        supplier_listed: ["WZ4X230D"], supplier_agreement: "competing number" });
    }
    expect(at("BACKSPLASH, BLOWER & MOTOR ASSEMBLY", "217")).toMatchObject({ supplier_listed: [], supplier_agreement: "not listed by supplier" });
    expect(summary.ge_position_supplier_agreement).toEqual({ catalog: 70, replacement: 20, "competing number": 2, "not listed by supplier": 2 });
    expect(summary.ge_supplier_callouts_outside_oem).toEqual([
      "BACKSPLASH, BLOWER & MOTOR ASSEMBLY #N/I WD21X10261", "CABINET & TOP PANEL #254 WE2X21976",
      "CABINET & TOP PANEL #417 WE1X21955", "CABINET & TOP PANEL #418 WE1X21975"
    ]);
    expect(comparison.find(r => r.printed_d1 === "WE01X25535")?.live_supplier_positions).toEqual([
      "BACKSPLASH, BLOWER & MOTOR ASSEMBLY #75", "CABINET & TOP PANEL #75", "DRUM #75"
    ]);
    // The supplier no longer prints Drum 515's catalog number WE1M1015; it now lists the replacement WE13X29439.
    expect(summary.ge_live_supplier_keys_not_in_cache).toContain("WE13X29439");
    expect(summary.ge_live_supplier_keys_not_in_cache).not.toContain("WE1M1015");
    expect(summary.ge_cache_keys_not_on_live_supplier).toEqual(["WPTEST"]);
  });

  it("exports every fleet ID once and finds sold and event-only MPNs outside the current BOM", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "pe-audit-test-"));
    try {
      const dir = await writeReports(snapshot, temp);
      const readCsv = async (file: string) => parseCsvRows(await readFile(path.join(dir, file), "utf8"));
      const [fields, ...rows] = await readCsv("fleet-exceptions.csv");
      expect(rows.map(r => r[fields.indexOf("machine_no")])).toEqual(snapshot.fleet.map(r => r.machine_no));
      expect(fields).not.toContain("notes");
      expect(rows.find(r => r[0] === "one")?.[fields.indexOf("unmatched_history_rows")]).toBe("2");
      const [historyFields, ...history] = await readCsv("part-history.csv");
      const records = history.map(row => Object.fromEntries(historyFields.map((field, i) => [field, row[i]])));
      expect(records).toEqual(expect.arrayContaining([
        expect.objectContaining({ mpn_canonical: "OLD", disposition: "sold", sold_price: "17.00", edge_match: "unmatched historical MPN" }),
        expect.objectContaining({ mpn_canonical: "EVENTONLY", action: "repair", repair_machine_no: "three", edge_match: "unmatched historical MPN" })
      ]));
    } finally { await rm(temp, { recursive: true, force: true }); }
  });
});
