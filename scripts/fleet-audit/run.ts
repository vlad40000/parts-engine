import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { neon } from "@neondatabase/serverless";
import { spreadsheetCell, toCsv } from "../../src/lib/csv";
import { audit, type Snapshot } from "./report";

export const queryNames = ["fleet", "history", "ge-cache"] as const;
export const readQuery = (name: typeof queryNames[number]) =>
  readFile(new URL(`./${name}.sql`, import.meta.url), "utf8");

async function readSnapshot(): Promise<Snapshot> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Set DATABASE_URL to the Parts Engine database or pass --snapshot <audit-input.json>.");
  const queries = ["select current_timestamp::text as audited_at", ...await Promise.all(queryNames.map(readQuery))];
  let rows;
  if (url.startsWith("pglite:")) {
    const { PGlite } = await import("@electric-sql/pglite");
    const { stat } = await import("node:fs/promises");
    const dir = url.slice("pglite:".length);
    await stat(resolve(dir, "PG_VERSION")); // Do not initialize an empty database on a typo.
    const db = new PGlite(dir);
    try {
      rows = await db.transaction(async tx => {
        await tx.exec("set transaction isolation level repeatable read, read only");
        const results = [];
        for (const sql of queries) results.push((await tx.query(sql)).rows);
        return results;
      });
    } finally { await db.close(); }
  } else {
    const db = neon(url);
    rows = await db.transaction(queries.map(sql => db.query(sql)), { isolationLevel: "RepeatableRead", readOnly: true });
  }
  const [clock, fleet, history, ge] = rows;
  return { audited_at: (clock[0] as {audited_at: string}).audited_at,
    fleet: fleet as Snapshot["fleet"], history: history as Snapshot["history"], ge: ge as Snapshot["ge"] };
}

function csv<T extends object>(rows: T[], fields: (keyof T & string)[]) {
  return toCsv(fields, rows.map(row => fields.map(field => {
    const value = row[field];
    return spreadsheetCell(value != null && typeof value === "object" ? JSON.stringify(value) : value);
  })));
}

export async function writeReports(snapshot: Snapshot, parent: string) {
  const report = audit(snapshot);
  const fields = [
    "machine_no", "availability", "brand", "model_raw", "serial", "identity_status", "serial_present", "serial_evidence",
    "age_candidate_years", "age_confidence", "repeated_identity_ids", "confirmed_physical_unit",
    "model_bom_found", "cache_status", "brand_display", "model_display", "cache_label_match", "model_spellings",
    "source", "source_url", "fetched_at", "row_count", "edge_count", "dropped_rows", "diagram_digest",
    "reviewed_exact_model_source", "reviewed_oem_retrieval", "reviewed_supplier_source",
    "reviewed_supplier_retrieval", "cache_retrieval_completeness", "variation",
    "unmatched_history_rows", "machine_applicability", "verification", "reasons"
  ] satisfies (keyof typeof report.machines[number])[];
  const files = {
    "fleet-exceptions.csv": csv(report.machines, fields),
    "ge-machines.csv": csv(report.geMachines, fields),
    "ge-cache-comparison.csv": csv(report.comparison, ["mpn_display", "printed_d1", "mpn_canonical", "diagram_id",
      "source", "source_url", "outcome", "oem_matches", "live_supplier_positions", "serial_applicability", "harvested_identity"]),
    "ge-catalog-positions.csv": csv(report.positions, ["assembly", "callout", "catalog_mpn", "catalog_d1",
      "replacement_mpn", "replacement_d1", "source", "reviewed_on", "catalog_in_cache", "replacement_in_cache",
      "supplier_listed", "supplier_agreement"]),
    "maytag-6613.json": JSON.stringify(report.maytag, null, 2) + "\n",
    "part-history.csv": csv(report.history, ["machine_no", "mpn_canonical", "origin", "event_id", "action", "disposition",
      "previous_disposition", "sold_price", "previous_sold_price", "repair_machine_no", "recorded_at", "applied", "edge_match"])
  };
  await mkdir(parent, { recursive: true });
  const dir = await mkdtemp(resolve(parent, "fleet-audit-"));
  for (const [name, body] of Object.entries(files)) await writeFile(resolve(dir, name), body);
  // The summary is written last, so it only exists for a finished report set.
  await writeFile(resolve(dir, "summary.json"), JSON.stringify(report.summary, null, 2) + "\n");
  return dir;
}

async function main(args: string[]) {
  let snapshot: Snapshot;
  if (args.length === 2 && args[0] === "--snapshot") {
    snapshot = JSON.parse(await readFile(args[1], "utf8"));
  } else if (!args.length) {
    snapshot = await readSnapshot();
  } else throw new Error("Usage: npm run audit:fleet [-- --snapshot <audit-input.json>]");
  console.log(await writeReports(snapshot, resolve("exports")));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    // The database driver can include credentials/SQL in diagnostic objects.
    console.error(error instanceof Error ? error.message.replace(/postgres(?:ql)?:\/\/\S+/gi, "[database URL]") : "Fleet audit failed");
    process.exitCode = 1;
  });
}
