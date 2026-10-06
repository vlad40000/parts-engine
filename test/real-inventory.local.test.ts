import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { mapFleetRows, readFleetFile } from "@/src/lib/fleet-import";
import { bandsFor, DEFAULT_AGE_BANDS } from "@/src/lib/serial-decoder";

const path = process.env.INVENTORY_XLSX;

describe.skipIf(!path)("real inventory workbook (local only, never committed)", () => {
  it("parses and reports counts", async () => {
    const buf = await readFile(path as string);
    const records = await readFleetFile(path as string, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const res = mapFleetRows(records, new Date("2026-10-06"));
    const live = res.rows.filter((r) => r.availability !== "SOLD" && r.availability !== "SCRAPED");
    const conf = { unique: 0, ambiguous: 0, none: 0 } as Record<string, number>;
    const band: Record<string, number> = {};
    const fam: Record<string, number> = {};
    let suspects = 0;
    for (const r of live) {
      conf[r.ageConfidence] += 1;
      for (const b of bandsFor(r.ageCandidateYears)) band[b] = (band[b] ?? 0) + 1;
      fam[r.ageFamily ?? "none"] = (fam[r.ageFamily ?? "none"] ?? 0) + 1;
      if (r.suspectFamilies.length) suspects += 1;
    }
    const models = new Set(live.filter((r) => r.identityStatus === "ok").map((r) => `${r.brandKey}::${r.modelKey}`));
    console.log(JSON.stringify({
      total: res.rows.length, live: live.length, skipped: res.skipped.length, duplicates: res.duplicates.length,
      ignored: res.ignoredColumns, needsNameplate: live.filter((r) => r.identityStatus !== "ok").length,
      uniqueModels: models.size, conf, band, fam, suspects, bands: DEFAULT_AGE_BANDS.map((b) => b.key)
    }, null, 1));
    expect(res.rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(res.rows)).not.toMatch(/Hemingway SC/);
  });
});
