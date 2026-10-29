import { describe, expect, it } from "vitest";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { readCard, readerConfig } from "@/src/lib/tech-notes/reader";
import { normalizeReading } from "@/src/lib/tech-notes/reading";
import { partKind } from "@/src/lib/tech-notes/plan";

/**
 * Real-photo OCR trial (local only, never committed: photos stay outside the repo).
 *
 *   GEMINI_API_KEY=… OCR_TRIAL_DIR=/path/to/photos [OCR_TRIAL_TIER=careful] [OCR_TRIAL_OUT=trial.json] \
 *     npx vitest run test/ocr-trial.local.test.ts
 *
 * Reads every .jpg/.jpeg/.png/.webp/.heic in the folder with the configured reader and prints, per
 * photo: the form type, date, each machine number with its confidence, status, location, part
 * decisions and anything unreadable. Compare it with the photos by eye before production use.
 */
const dir = process.env.OCR_TRIAL_DIR;
const cfg = readerConfig();
const TYPES: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".heic": "image/heic" };

describe.skipIf(!dir || !cfg)("real-photo OCR trial (local only)", () => {
  it("reads every photo in OCR_TRIAL_DIR", async () => {
    const files = (await readdir(dir as string)).filter((f) => TYPES[path.extname(f).toLowerCase()]).sort();
    expect(files.length).toBeGreaterThan(0);
    const tier = process.env.OCR_TRIAL_TIER === "careful" ? "careful" : "quick";
    const results: unknown[] = [];
    for (const file of files) {
      const bytes = await readFile(path.join(dir as string, file));
      const started = Date.now();
      try {
        const { reading, model } = await readCard(cfg!, { base64: bytes.toString("base64"), mimeType: TYPES[path.extname(file).toLowerCase()] }, [], tier);
        const r = normalizeReading(reading);
        results.push({
          file, model, ms: Date.now() - started, card: r.card, date: r.date, unreadable: r.unreadable,
          entries: r.entries.map((e) => ({
            machine: e.machine, status: e.status, location: e.location, readyForClean: e.readyForClean, problem: e.problem,
            parts: e.parts.map((p) => ({ mpn: p.mpn, name: p.name, decision: partKind(p) ?? "mention", other: p.otherMachine })), struck: e.struck
          })),
          groups: r.groups.map((g) => ({ text: g.text, appliesTo: g.appliesTo, confidence: g.confidence }))
        });
      } catch (e) {
        results.push({ file, error: e instanceof Error ? e.message : String(e) });
      }
    }
    const json = JSON.stringify(results, null, 1);
    if (process.env.OCR_TRIAL_OUT) await writeFile(process.env.OCR_TRIAL_OUT, json);
    console.log(json);
    expect(results.filter((r) => (r as { error?: string }).error)).toEqual([]);
  }, 30 * 60 * 1000);
});
