import { beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import ExcelJS from "exceljs";
import path from "node:path";
import * as schema from "@/src/db/schema";
import type { Db } from "@/src/db/types";
import {
  addAlias, getSettings, mpnDetail, mpnIndex, researchQueueCsvRows, researchQueueExport, saveModelBom, saveSettings, upsertFleet
} from "@/src/db/queries";
import { parseCsvRows, toCsv } from "@/src/lib/csv";
import { mapFleetRows } from "@/src/lib/fleet-import";
import { mapMarketRows } from "@/src/lib/market-import";
import {
  buildSharedResearchCsv, buildSharedResearchExport, parseSharedResearchCsv, SHARED_RESEARCH_CSV_HEADERS, SHARED_RESEARCH_MAX_ROWS, SHARED_RESEARCH_MAX_BYTES, SharedResearchExportError
} from "@/src/lib/shared-research-csv";
import type { ChainResult } from "@/src/sources/chain";
import type { SupplierRow } from "@/src/sources/types";
import { importMarketAction, saveMarketAction } from "@/app/actions";
import { GET as exportQueue } from "@/app/api/export/research-queue/route";

// Server actions and the export route run against this file's PGlite database.
const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/src/db", () => ({ getDb: async () => holder.db, hasDatabase: () => true }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

/** EbayDecisions' canonical header line (its src/lib/shared-research-csv.ts), verbatim. */
const EBAYDECISIONS_HEADER_LINE =
  "mpn,description,notes,New Price,7 Day sales,7 Day Avg Price,30 Day sales,30 Day Avg Price,90 Day sales,90 Day Avg Price,90 Day Sell Through %";
type Header = (typeof SHARED_RESEARCH_CSV_HEADERS)[number];

const BOARD = "W11165528";
const PUMP = "W10006355";
const LID = "W10820048";
const FUSE = "DC47-00019A";
const VALVE = "W10144820";
const TODAY = new Date().toISOString().slice(0, 10);
let db: Db;

const part = (mpnDisplay: string, description: string, newPrice: number | null): SupplierRow => ({
  mpnDisplay, mpnCanonical: mpnDisplay.replace(/[^A-Z0-9]/gi, "").toUpperCase(), description, diagramId: "1", supplierPartId: null, newPrice, nla: false
});
const chain = (rows: SupplierRow[]): ChainResult => ({
  status: "found",
  winner: { supplier: "encompass", status: "found", rows, droppedRows: 0, sourceUrl: "https://x", visited: [], warnings: [], elapsedMs: 1 },
  attempts: [{ supplier: "encompass", status: "found", droppedRows: 0, sourceUrl: "https://x", visited: [], warnings: [], elapsedMs: 1 }]
});
const washer = (id: number) => ({ ID: id, Availability: "UNCHECKED", ApplianceType: "Washer - Top Load", Brand: "Maytag", ModelNumber: "MVWX655DW1", SerialNumber: "" });
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  return f;
};
const importFile = (name: string, content: BlobPart) => {
  const f = new FormData();
  f.set("file", new File([content], name));
  return importMarketAction(null, f);
};
/** A shared research CSV with the canonical header; cells by header, blank when absent. */
const sharedCsv = (rows: Array<Partial<Record<Header, string>>>) =>
  toCsv([...SHARED_RESEARCH_CSV_HEADERS], rows.map((r) => SHARED_RESEARCH_CSV_HEADERS.map((h) => r[h] ?? "")));
const exported = async () => (await exportQueue()).text();
/** Every generated export must import as is: parses it with the import's own validator. */
const importable = (text: string) => {
  const parsed = parseSharedResearchCsv(text);
  if (!parsed.ok) throw new Error(`${parsed.error}\n${parsed.errors.join("\n")}`);
  return parsed.rows;
};
const facts = async (mpn: string) => (await db.select().from(schema.marketFacts).where(eq(schema.marketFacts.mpnCanonical, mpn)))[0];
const master = async (mpn: string) => (await db.select().from(schema.mpnMaster).where(eq(schema.mpnMaster.mpnCanonical, mpn)))[0];
const byKey = <T extends { mpnCanonical: string }>(rows: T[]) => rows.sort((a, b) => a.mpnCanonical.localeCompare(b.mpnCanonical));
const snapshot = async () => ({
  facts: byKey(await db.select().from(schema.marketFacts)),
  master: byKey(await db.select().from(schema.mpnMaster))
});

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  holder.db = db;
  await migrate(drizzle(client), { migrationsFolder: path.join(__dirname, "..", "drizzle") });
  await upsertFleet(db, mapFleetRows([washer(1), washer(2)]).rows);
  await saveModelBom(db, {
    brandKey: "MAYTAG", modelKey: "MVWX655DW1", brandDisplay: "Maytag", modelDisplay: "MVWX655DW1",
    result: chain([
      part(BOARD, "Washer Electronic Control Board", 180), part(PUMP, "Drain Pump", 60), part(LID, "Lid Lock", null),
      part(FUSE, "Thermal Fuse", 12.4), part(VALVE, "Water Inlet Valve", 35)
    ])
  });
  // Rules set, so a part without exact sell-through answers NEEDS DATA rather than SET RULE.
  await saveSettings(db, { ...(await getSettings(db)), minimumSellThroughPct: 30, minimumProfitMarginPct: 25 });
});

describe("Export queue CSV: the shared research format", () => {
  it("writes EbayDecisions' exact headers in order, New Price from new_price_min, and blank research columns", async () => {
    const text = await exported();
    expect(text.split("\r\n")[0]).toBe(EBAYDECISIONS_HEADER_LINE);
    const [header, ...rows] = parseCsvRows(text);
    expect(header).toEqual([...SHARED_RESEARCH_CSV_HEADERS]);
    const row = new Map(rows.map((r) => [r[0], r]));
    expect([...row.keys()].sort()).toEqual([BOARD, PUMP, LID, FUSE, VALVE].sort());
    // Display MPN as stored, the MPN-index description, Parts Engine context in notes.
    expect(row.get(FUSE)!.slice(0, 2)).toEqual([FUSE, "Thermal Fuse"]);
    expect(row.get(FUSE)![2]).toMatch(/^Parts Engine: 2 donor machine\(s\) across 1 model\(s\); family /);
    expect([row.get(BOARD)![3], row.get(FUSE)![3], row.get(LID)![3]]).toEqual(["180.00", "12.40", ""]);
    for (const r of rows) expect(r.slice(4)).toEqual(["", "", "", "", "", "", ""]);
    expect(importable(text)).toHaveLength(rows.length);
  });

  it("only writes cells EbayDecisions accepts: a display that would not map back becomes the D1 key; descriptions clip to 500", () => {
    const csv = buildSharedResearchCsv([
      { mpnCanonical: "W10545371", mpnDisplay: "WPW10545371", description: "d".repeat(600), notes: "n", newPrice: null },
      { mpnCanonical: "DC4700019A", mpnDisplay: " DC47-00019A ", description: " Thermal Fuse ", notes: "", newPrice: "12.4" }
    ]);
    const [, wp, fuse] = parseCsvRows(csv);
    expect(wp.slice(0, 4)).toEqual(["W10545371", "d".repeat(500), "n", ""]);
    expect(fuse.slice(0, 4)).toEqual(["DC47-00019A", "Thermal Fuse", "", "12.40"]);
    expect(importable(csv)).toHaveLength(2);
  });

  it("never writes a file its own import rejects: overlong keys left out whole, an out-of-range New Price blank, at most 5,000 rows", () => {
    const row = (mpnCanonical: string, newPrice: string | number | null = null) =>
      ({ mpnCanonical, mpnDisplay: mpnCanonical, description: "Drain Pump", notes: "", newPrice });
    const OVERLONG = "A".repeat(201);
    const LONGEST = "B".repeat(200);
    const filler = Array.from({ length: SHARED_RESEARCH_MAX_ROWS }, (_, i) => `Q${i}`);
    const out = buildSharedResearchExport([
      row(OVERLONG), row(LONGEST), row("BIG1", "1000000.01"), row("TOP1", "1000000.00"), row("NEG1", -1), ...filler.map((k) => row(k, 60))
    ]);
    const rows = importable(out.csv);
    expect(parseCsvRows(out.csv)[0]).toEqual([...SHARED_RESEARCH_CSV_HEADERS]);
    // The first 5,000 exportable rows in the order given; the last 4 wait for the next batch.
    expect(rows.map((r) => r.mpnCanonical)).toEqual([LONGEST, "BIG1", "TOP1", "NEG1", ...filler.slice(0, SHARED_RESEARCH_MAX_ROWS - 4)]);
    expect(out).toMatchObject({ exported: SHARED_RESEARCH_MAX_ROWS, later: 4, omittedMpns: [OVERLONG] });
    // Left out whole: no shortened form of the overlong key is written.
    expect(out.csv).not.toContain("A".repeat(10));
    // Kept, New Price blank only where the import would reject it, never clamped.
    expect(rows.slice(1, 4).map((r) => [r.mpnCanonical, r.newPrice])).toEqual([["BIG1", null], ["TOP1", 1_000_000], ["NEG1", null]]);
    expect(out.blankNewPrices).toEqual([{ mpnCanonical: "BIG1", newPrice: "1000000.01" }, { mpnCanonical: "NEG1", newPrice: -1 }]);
  });
  it("prefixes formula-triggering supplier cells while preserving D1 identity and cross-app parsing", () => {
    const cases = [
      { mpnCanonical: "EQ1", mpnDisplay: "=EQ-1", description: "=HYPERLINK(1)", notes: "=1+1" },
      { mpnCanonical: "PL2", mpnDisplay: "+PL-2", description: "+SUM(1,2)", notes: "+1" },
      { mpnCanonical: "MI3", mpnDisplay: "-MI-3", description: "-1+1", notes: "-1" },
      { mpnCanonical: "AT4", mpnDisplay: "@AT-4", description: "@SUM(1,2)", notes: "@1" },
      { mpnCanonical: "MAX5", mpnDisplay: "=" + "MAX5".padEnd(199, "-"), description: "=X".padEnd(500, "Y"), notes: " \n=2+2" }
    ];
    // The last display MPN has 200 characters; protection must fall back to D1 rather than emit 201.
    const csv = buildSharedResearchCsv(cases.map((r) => ({ ...r, newPrice: null })));
    const [, ...cells] = parseCsvRows(csv);
    for (const row of cells.slice(0, 4)) {
      expect(row[0]).toMatch(/^'[=+\-@]/);
      expect(row[1]).toMatch(/^'[=+\-@]/);
      expect(row[2]).toMatch(/^'[=+\-@]/);
    }
    expect(cells[4][0]).toBe("MAX5");
    expect(cells[4][1]).toHaveLength(500);
    expect(cells[4][2]).toMatch(/^'\s+=/);
    expect(importable(csv).map((r) => r.mpnCanonical)).toEqual(cases.map((r) => r.mpnCanonical));
  });

  it("reserves UTF-8 byte headroom for all seven edited cells, and splits big queues at the 2 MiB upload limit", () => {
    const rows = Array.from({ length: SHARED_RESEARCH_MAX_ROWS }, (_, i) => ({
      mpnCanonical: `UTF${i}`, mpnDisplay: `UTF${i}`, description: "é".repeat(450),
      notes: "Donation units: 🔧".repeat(6), newPrice: null
    }));
    const batch = buildSharedResearchExport(rows);
    expect(batch.exported).toBeGreaterThan(0);
    expect(batch.exported).toBeLessThan(SHARED_RESEARCH_MAX_ROWS);
    expect(batch.later).toBe(SHARED_RESEARCH_MAX_ROWS - batch.exported);
    expect(Buffer.byteLength(batch.csv, "utf8")).toBeLessThanOrEqual(SHARED_RESEARCH_MAX_BYTES);
    const [headers, ...cells] = parseCsvRows(batch.csv);
    const completed = toCsv(headers, cells.map((row) => row.map((cell, col) => (
      col === 4 || col === 6 || col === 8 ? "1000000"
      : col === 5 || col === 7 || col === 9 ? "1000000.00"
      : col === 10 ? "9999.99" : cell
    ))));
    expect(Buffer.byteLength(completed, "utf8")).toBeLessThanOrEqual(SHARED_RESEARCH_MAX_BYTES);
    expect(importable(completed)).toHaveLength(batch.exported);
    const compact = buildSharedResearchExport(Array.from({ length: SHARED_RESEARCH_MAX_ROWS }, (_, i) => ({
      mpnCanonical: `C${i}`, mpnDisplay: `C${i}`, description: "Pump", notes: "", newPrice: 11
    })));
    expect(compact.exported).toBe(SHARED_RESEARCH_MAX_ROWS);
    expect(compact.later).toBe(0);
    expect(() => buildSharedResearchExport([{
      mpnCanonical: "HUGE", mpnDisplay: "HUGE", description: "Pump", notes: "Q".repeat(3 * 1024 * 1024), newPrice: null
    }])).toThrow(SharedResearchExportError);
  });

});

describe("Import: the same completed CSV, without conversion", () => {
  it("an unedited export uploaded as is changes no market facts, stamps no research date and leaves New Price as it was", async () => {
    await saveMarketAction(form({ mpn: BOARD, sold90: "4", avgPrice: "150", avgShip: "12", sellThroughPct: "33", activeQty: "9", researchedAt: "2026-01-02" }));
    const before = await snapshot();
    const text = await exported();
    expect(parseCsvRows(text).map((r) => r[0])).toContain(BOARD); // stale research is back in the queue

    const res = await importFile("research-queue.csv", text);
    expect(res).toEqual({
      ok: true,
      message: "Imported the shared research CSV: 90-day research saved for 0 MPNs, New Price changed for 0.",
      details: [
        "No 90-day research and no New Price, left as they were (no new research date): 1.",
        "Accepted, not stored in Parts Engine: notes, 7 Day sales, 7 Day Avg Price, 30 Day sales, 30 Day Avg Price."
      ]
    });
    expect(await snapshot()).toEqual(before);
  });

  it("round trip: the export, filled in by the operator, imports as is", async () => {
    const [header, ...rows] = parseCsvRows(await exported());
    const filled = rows.map((r) => {
      if (r[0] !== BOARD) return r;
      const out = [...r];
      const set = (h: Header, v: string) => { out[header.indexOf(h)] = v; };
      set("7 Day sales", "1");
      set("30 Day sales", "3");
      set("90 Day sales", "7");
      set("90 Day Avg Price", "$139.99");
      set("90 Day Sell Through %", "38.5");
      return out;
    });
    expect((await importFile("research-queue-done.csv", toCsv(header, filled))).ok).toBe(true);
    expect(await facts(BOARD)).toMatchObject({
      sold90: 7, avgPrice: "139.99", sellThroughPct: "38.50", sellThroughSource: "research", researchedAt: TODAY, source: "shared_research_csv",
      // The new observation has no shipping, so the older 12 is cleared, as the EbayDecisions path does.
      avgShip: null,
      // Not in the shared file, so never written by it.
      activeQty: 9
    });
  });

  it("maps New Price and the 90-day window; blanks stay null, never zero; new research clears old shipping; local facts are untouched", async () => {
    await saveMarketAction(form({ mpn: PUMP, sold90: "5", avgPrice: "64", avgShip: "8", sellThroughPct: "20", activeQty: "6",
      qtyOnHand: "3", researchedAt: "2026-05-01", freeShipping: "on", shipCost: "14" }));
    await saveMarketAction(form({ mpn: LID, sold90: "2", avgPrice: "40", avgShip: "7", sellThroughPct: "", activeQty: "4", researchedAt: "2026-04-01" }));
    const lidBefore = await facts(LID);

    const res = await importFile("done.csv", sharedCsv([
      { mpn: FUSE, description: "Thermal Fuse", "New Price": "$14.99", "7 Day sales": "1", "7 Day Avg Price": "15", "30 Day sales": "3",
        "30 Day Avg Price": "15.5", "90 Day sales": "12", "90 Day Avg Price": "$16.25", "90 Day Sell Through %": "45" },
      { mpn: PUMP, "90 Day sales": "3" },
      { mpn: LID, "New Price": "1,250.00" },
      { mpn: VALVE },
      { mpn: "ZX-9001", description: "Door Boot Seal", "90 Day sales": "0", "90 Day Sell Through %": "0" }
    ]));
    expect(res).toEqual({
      ok: true,
      message: "Imported the shared research CSV: 90-day research saved for 3 MPNs, New Price changed for 2.",
      details: [
        "No 90-day research and no New Price, left as they were (no new research date): 1.",
        "Saved without 90 Day Sell Through % (left blank, needs research; never calculated): 1.",
        `Researched rows with no research date, dated ${TODAY} (the import date): 3.`,
        "Not in any parts list yet (added to the MPN index with no donors): 1.",
        "Accepted, not stored in Parts Engine: notes, 7 Day sales, 7 Day Avg Price, 30 Day sales, 30 Day Avg Price."
      ]
    });

    // A full row: New Price → new_price_min; 90 Day sales / Avg Price / Sell Through % → sold_90 / avg_price / sell_through_pct.
    expect(await facts("DC4700019A")).toMatchObject({
      sold90: 12, avgPrice: "16.25", sellThroughPct: "45.00", sellThroughSource: "research", researchedAt: TODAY, source: "shared_research_csv",
      avgShip: null, activeQty: null
    });
    expect((await master("DC4700019A"))!.newPriceMin).toBe("14.99");
    // The 90-day values are one observation: blank price and sell-through are unknown now, not the older 64 / 20, and not zero.
    // Buyer shipping is unknown for it too, so the older 8 is cleared; active count and local fields stay.
    expect(await facts(PUMP)).toMatchObject({
      sold90: 3, avgPrice: null, sellThroughPct: null, sellThroughSource: null, researchedAt: TODAY, source: "shared_research_csv",
      avgShip: null, activeQty: 6, qtyOnHand: 3, freeShipping: true, shipCost: "14.00"
    });
    // A blank New Price leaves the stored one alone.
    expect((await master(PUMP))!.newPriceMin).toBe("60.00");
    // New Price alone is not research: market facts, their research date and shipping stay as they were.
    expect((await master(LID))!.newPriceMin).toBe("1250.00");
    expect(lidBefore.avgShip).toBe("7.00");
    expect(await facts(LID)).toEqual(lidBefore);
    // Nothing supplied, nothing written.
    expect(await facts(VALVE)).toBeUndefined();
    // Supplied zeros stay zeros; an MPN new to Parts Engine joins the index with the file's display and description.
    expect(await facts("ZX9001")).toMatchObject({ sold90: 0, avgPrice: null, sellThroughPct: "0.00", sellThroughSource: "research" });
    expect(await master("ZX9001")).toMatchObject({ mpnDisplay: "ZX-9001", description: "Door Boot Seal", newPriceMin: null });
  });

  it("reads 90 Day Sell Through % in percentage points as typed (45 = 45%, 0.45 = 0.45%); only legacy columns keep the ≤ 1 fraction rule", async () => {
    const res = await importFile("str.csv", sharedCsv([
      { mpn: "STR-1", "90 Day Sell Through %": "45" },
      { mpn: "STR-2", "90 Day Sell Through %": "0.45" },
      { mpn: "STR-3", "90 Day Sell Through %": "45%" },
      { mpn: "STR-4", "90 Day Sell Through %": "0.45 %" },
      { mpn: "STR-5", "90 Day Sell Through %": "1" },
      { mpn: "STR-6", "90 Day Sell Through %": "250" }
    ]));
    expect(res.ok).toBe(true);
    const str = async (k: string) => (await facts(k))?.sellThroughPct;
    expect(await Promise.all(["STR1", "STR2", "STR3", "STR4", "STR5", "STR6"].map(str))).toEqual(["45.00", "0.45", "45.00", "0.45", "1.00", "250.00"]);
    // EbayDecisions' other spelling of the column is the same column with the same meaning.
    expect((await importFile("alias.csv", "mpn,90_day_sell_through_pct\nSTR-7,0.3\n")).ok).toBe(true);
    expect(await str("STR7")).toBe("0.30");

    // The older plain CSV and the decision workbook still read 0.45 / 0.35 as 45% / 35%.
    expect((await importFile("legacy.csv", "mpn,sold90,sell_through_pct\nSTR-8,4,0.45\nSTR-9,4,45\n")).ok).toBe(true);
    expect(await Promise.all(["STR8", "STR9"].map(str))).toEqual(["45.00", "45.00"]);
    expect(mapMarketRows([{ MPN: "X1", "Mkt Sold 90d": 3, "Mkt 90d Sell-Through": 0.35 }]).rows[0].sellThroughPct).toBe(35);
  });

  it("accepts 7- and 30-day columns and extra columns without failing, and stores none of them", async () => {
    const before = await snapshot();
    const res = await importFile("windows.csv", toCsv(
      ["MPN", "7 Day sales", "7 Day Avg Price", "30 Day sales", "30 Day Avg Price", "Seller notes"],
      [[BOARD, "n/a", "about $12", "-3", "lots", "call back"]]
    ));
    expect(res).toEqual({
      ok: true,
      message: "Imported the shared research CSV: 90-day research saved for 0 MPNs, New Price changed for 0.",
      details: [
        "No 90-day research and no New Price, left as they were (no new research date): 1.",
        "Accepted, not stored in Parts Engine: 7 Day sales, 7 Day Avg Price, 30 Day sales, 30 Day Avg Price.",
        "Columns not imported: Seller notes."
      ]
    });
    expect(await snapshot()).toEqual(before);
  });

  it("never derives sell-through, even with sold and active counts on hand", async () => {
    await saveMarketAction(form({ mpn: VALVE, sold90: "", avgPrice: "", avgShip: "", sellThroughPct: "", activeQty: "70", researchedAt: "2026-03-01" }));
    expect((await importFile("valve.csv", sharedCsv([{ mpn: VALVE, "90 Day sales": "30", "90 Day Avg Price": "42" }]))).ok).toBe(true);
    expect(await facts(VALVE)).toMatchObject({ sold90: 30, avgPrice: "42.00", activeQty: 70, sellThroughPct: null, sellThroughSource: null });
    expect((await mpnDetail(db, VALVE))!.mpn.qualification).toMatchObject({ result: "NEEDS_DATA", missing: expect.arrayContaining(["sell_through"]) });
  });

  it("uses a research date column when present and the import date otherwise; a row without 90-day values gets none", async () => {
    const res = await importFile("dated.csv", toCsv(
      ["mpn", "New Price", "90 Day sales", "researched_at"],
      [["DATE-1", "", "5", "2026-09-30"], ["DATE-2", "", "6", "10/1/2026"], ["DATE-3", "", "7", ""], ["DATE-4", "9.99", "", "2026-09-30"]]
    ));
    expect(res.ok).toBe(true);
    expect(await Promise.all(["DATE1", "DATE2", "DATE3"].map(async (k) => (await facts(k))?.researchedAt))).toEqual(["2026-09-30", "2026-10-01", TODAY]);
    expect(await facts("DATE4")).toBeUndefined();
    expect((await master("DATE4"))?.newPriceMin).toBe("9.99");

    const bad = await importFile("bad-date.csv", toCsv(["mpn", "90 Day sales", "research_date"], [["DATE-5", "1", "last week"]]));
    expect(bad).toEqual({
      ok: false,
      message: "1 problem found; nothing was imported. Fix the file and upload it again.",
      details: ['Line 2: research date "last week" is not a date; use YYYY-MM-DD or M/D/YYYY, or leave it blank.']
    });
    expect(await master("DATE5")).toBeUndefined();
  });

  it("validates the whole file first: any bad cell or repeated MPN rejects it and nothing is saved", async () => {
    const before = await snapshot();
    const res = await importFile("bad.csv", sharedCsv([
      { mpn: "OK-1", "New Price": "10", "90 Day sales": "4" },
      { mpn: "BAD-1", "90 Day sales": "12 units" },
      { mpn: "BAD-2", "90 Day sales": "2.5" },
      { mpn: "BAD-3", "90 Day Avg Price": "-5" },
      { mpn: "BAD-4", "90 Day Sell Through %": "10000" },
      { mpn: "BAD-5", "New Price": "1e3" },
      { mpn: "dc47 00019a", "90 Day sales": "1" },
      { mpn: FUSE, "90 Day sales": "2" },
      { mpn: "", "90 Day sales": "3" }
    ]));
    expect(res).toEqual({
      ok: false,
      message: "7 problems found; nothing was imported. Fix the file and upload it again.",
      details: [
        'Line 3: "90 Day sales" is "12 units"; expected a whole number of 0 or more, or leave it blank.',
        'Line 4: "90 Day sales" is "2.5"; expected a whole number of 0 or more, or leave it blank.',
        'Line 5: "90 Day Avg Price" is "-5"; expected a price of 0 or more, or leave it blank.',
        'Line 6: "90 Day Sell Through %" is over 9,999.99 — check for a typo.',
        'Line 7: "New Price" is "1e3"; expected a price of 0 or more, or leave it blank.',
        "Line 10: no MPN.",
        "Lines 8, 9: the same MPN (key DC4700019A) appears more than once. Keep one row per MPN."
      ]
    });
    expect(await snapshot()).toEqual(before);
  });

  it("rejects a CSV mixing shared and older market columns and a shared file saved as a workbook; older workbooks still import", async () => {
    const before = await snapshot();
    expect(await importFile("mixed.csv", "mpn,90 Day sales,sold90,sell_through_pct\nMIX-1,4,4,0.45\n")).toEqual({
      ok: false,
      message: "This file mixes shared research columns with older market columns (sold90, sell_through_pct). Use one format per file; nothing was imported."
    });
    const workbook = async (header: string[], row: unknown[]) => {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("MPN Master");
      ws.addRow(header);
      ws.addRow(row);
      return wb.xlsx.writeBuffer();
    };
    // A percent-formatted cell would hold 0.45 for 45%, which the as-typed shared column cannot tell apart.
    expect(await importFile("research.xlsx", await workbook(["mpn", "90 Day sales", "90 Day Sell Through %"], ["XL-1", 4, 0.45]))).toEqual({
      ok: false,
      message: "The shared research file imports as .csv only. Save it as CSV and upload that; nothing was imported."
    });
    expect(await snapshot()).toEqual(before);

    const legacy = await importFile("decision-workbook.xlsx", await workbook(["MPN", "Mkt Sold 90d", "Mkt 90d Sell-Through", "Mkt Price"], ["XL-2", 3, 0.35, 95]));
    expect(legacy).toMatchObject({ ok: true, message: "Saved market facts for 1 MPNs." });
    expect(await facts("XL2")).toMatchObject({ sold90: 3, sellThroughPct: "35.00", avgPrice: "95.00", source: "market_import" });
  });

  it("resolves aliases like the market import, and refuses two rows that are one MPN through an alias", async () => {
    await addAlias(db, "WPW10006355", PUMP, "wp_prefix");
    const before = await snapshot();
    expect(await importFile("clash.csv", sharedCsv([{ mpn: "WPW10006355", "90 Day sales": "8" }, { mpn: PUMP, "90 Day sales": "9" }]))).toEqual({
      ok: false,
      message: `Lines 2, 3 are the same MPN (${PUMP}) through an alias. Keep one row per MPN; nothing was imported.`
    });
    expect(await snapshot()).toEqual(before);

    expect((await importFile("alias.csv", sharedCsv([{ mpn: "WPW10006355", "90 Day sales": "8" }]))).ok).toBe(true);
    expect(await facts(PUMP)).toMatchObject({ sold90: 8, source: "shared_research_csv" });
    expect(await facts("WPW10006355")).toBeUndefined();
  });
});

describe("parseSharedResearchCsv", () => {
  it("matches every header spelling EbayDecisions accepts, with its number formats", () => {
    expect(parseSharedResearchCsv(toCsv(
      ["MPN", "Description", "NEW_PRICE", "90_day_sales", "90-day avg price", "90_day_sell_through_%"],
      [["W1", "Pump", "$ 1,234.50", "1,234", "$12", "45 %"]]
    ))).toEqual({
      ok: true, notStored: [], ignored: [],
      rows: [{
        line: 2, mpnCanonical: "W1", mpnDisplay: "W1", description: "Pump", newPrice: 1234.5,
        research90: { sold90: 1234, avgPrice: 12, sellThroughPct: 45 }, researchedAt: null
      }]
    });
  });

  it("rejects what EbayDecisions rejects at file level", () => {
    expect(parseSharedResearchCsv("mpn,90 Day sales\n")).toMatchObject({ ok: false, error: "The file needs a header row and at least one data row." });
    expect(parseSharedResearchCsv("Part,90 Day sales\nW1,3\n")).toMatchObject({ ok: false, error: "No mpn column found. Header was: Part, 90 Day sales" });
    expect(parseSharedResearchCsv("mpn,90 Day sales,90_day_sales\nW1,3,3\n"))
      .toMatchObject({ ok: false, error: 'Columns "90 Day sales" and "90_day_sales" are both "90 Day sales". Keep one.' });
  });
});

// Last in the file: it adds over 5,000 MPNs to the queue.
describe("Export queue CSV: a queue over 5,000 MPNs goes out in batches", () => {
  it("each export is the next 5,000 in queue order and imports as is; overlong keys stay out whole; an out-of-range New Price goes blank, unchanged in Parts Engine", async () => {
    const OVERLONG = "A".repeat(201);
    const BIG = "BIGPRICE1";
    await upsertFleet(db, mapFleetRows([{ ...washer(3), ModelNumber: "MVWX500BW0" }]).rows);
    await saveModelBom(db, {
      brandKey: "MAYTAG", modelKey: "MVWX500BW0", brandDisplay: "Maytag", modelDisplay: "MVWX500BW0",
      result: chain([
        part(OVERLONG, "Drain Pump", 50), part("BIG-PRICE-1", "Washer Electronic Control Board", 1_500_000),
        ...Array.from({ length: SHARED_RESEARCH_MAX_ROWS + 3 }, (_, i) => part(`Q${String(i).padStart(5, "0")}`, `Drain Pump ${i}`, 60))
      ])
    });
    const queue = (await researchQueueCsvRows(db)).map((r) => r.mpn_canonical);
    expect(queue).toContain(OVERLONG);
    const exportable = queue.filter((k) => k !== OVERLONG);
    expect(exportable.length).toBeGreaterThan(SHARED_RESEARCH_MAX_ROWS);

    const text = await exported();
    const [header, ...cells] = parseCsvRows(text);
    expect(header).toEqual([...SHARED_RESEARCH_CSV_HEADERS]);
    const first = importable(text);
    expect(first.map((r) => r.mpnCanonical)).toEqual(exportable.slice(0, SHARED_RESEARCH_MAX_ROWS));
    expect(cells.every((r) => r[0].length <= 200 && !r[0].startsWith("AAAA"))).toBe(true);
    expect(first.find((r) => r.mpnCanonical === BIG)).toMatchObject({ newPrice: null });
    expect((await master(BIG))!.newPriceMin).toBe("1500000.00");
    // What the research queue view reports next to the button.
    expect(await researchQueueExport(db)).toMatchObject({
      exported: SHARED_RESEARCH_MAX_ROWS, later: exportable.length - SHARED_RESEARCH_MAX_ROWS,
      omittedMpns: [OVERLONG], blankNewPrices: [{ mpnCanonical: BIG, newPrice: "1500000.00" }]
    });

    // Research the batch and import it as is: those MPNs leave the queue, so the next export is the next batch.
    const filled = cells.map((r) => r.map((cell, i) => (header[i] === "90 Day sales" ? "2" : cell)));
    expect(await importFile("batch-1.csv", toCsv(header, filled))).toMatchObject({
      ok: true, message: expect.stringContaining(`90-day research saved for ${SHARED_RESEARCH_MAX_ROWS} MPNs`)
    });
    expect(importable(await exported()).map((r) => r.mpnCanonical)).toEqual(exportable.slice(SHARED_RESEARCH_MAX_ROWS));
    expect(await researchQueueExport(db)).toMatchObject({
      exported: exportable.length - SHARED_RESEARCH_MAX_ROWS, later: 0, omittedMpns: [OVERLONG], blankNewPrices: []
    });
    expect((await master(BIG))!.newPriceMin).toBe("1500000.00");
  });
  it("treats a sell-through-only observation as researched, but still requires missing sold and price data", async () => {
    const res = await importFile("str-only.csv", sharedCsv([{ mpn: BOARD, "90 Day Sell Through %": "42.5" }]));
    expect(res.ok).toBe(true);
    expect(await facts(BOARD)).toMatchObject({
      sold90: null, avgPrice: null, sellThroughPct: "42.50", researchedAt: TODAY
    });
    const queue = await mpnIndex(db, { view: "queue" }, 100000);
    expect(queue.rows.some((r) => r.mpn_canonical === BOARD)).toBe(false);
    const needsData = await mpnIndex(db, { view: "needs_data" }, 100000);
    const matching = needsData.rows.find((r) => r.mpn_canonical === BOARD);
    expect(matching).toMatchObject({ market: "current", qualification: { result: "NEEDS_DATA" } });
  });

});
