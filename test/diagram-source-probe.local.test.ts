import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createFetcher } from "@/src/sources/http";
import type { Fetcher, FetchResult } from "@/src/sources/types";
import {
  DIAGRAM_CASES, FIXTURE_ROOT, matrixRows, minimizeDiagramPage, readEveryWay, replayFetcher, runDiagramCase,
  type CaseManifest, type ManifestFetch, type OemCapture, type SourceOnlyCapture
} from "./diagram-sources-support";

/**
 * Read-only diagram source probe (local only, never in CI).
 *
 *   DIAGRAM_PROBE=live npx vitest run test/diagram-source-probe.local.test.ts     # network
 *   DIAGRAM_PROBE=raw  npx vitest run test/diagram-source-probe.local.test.ts     # re-read the last live capture, no network
 *   add DIAGRAM_PROBE_CASES=maytag-mvw6230hw1,…  to limit cases
 *   add DIAGRAM_PROBE_WRITE_FIXTURES=1           to replace test/fixtures/diagrams/<case>/
 *
 * Live: GET only, one request at a time per host with two seconds between starts, a 20-second timeout and no
 * retries. A 401/403/429, bot-check page, 404 or redirect to another model is recorded as the outcome; nothing is
 * bypassed. Raw responses and a raw manifest go to local/diagram-probe/<case>/ (gitignored). Before fixtures are
 * written, the minimized pages are replayed and must give exactly the evidence the full pages gave. The OEM PDF is
 * converted with pdftotext (Xpdf or poppler), which must be on PATH for a live run.
 */
const mode = process.env.DIAGRAM_PROBE;
const only = process.env.DIAGRAM_PROBE_CASES?.split(",").map((s) => s.trim()).filter(Boolean);
const writeFixtures = process.env.DIAGRAM_PROBE_WRITE_FIXTURES === "1";
const RAW_ROOT = path.resolve(__dirname, "..", "local", "diagram-probe");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const toLf = (text: string) => text.replace(/\r\n?/g, "\n");
const slug = (url: string) => new URL(url).pathname.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 70) || "index";

type RawManifest = {
  capturedAt: string;
  fetches: Array<{ requested: string; status: number; finalUrl: string; file: string }>;
  oem?: Omit<OemCapture, "text"> & { file: string };
};

async function captureOemPdf(url: string, dir: string): Promise<OemCapture> {
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30_000), headers: { "User-Agent": UA, Accept: "application/pdf" } });
  const bytes = new Uint8Array(await res.arrayBuffer());
  const file = path.join(dir, "oem-parts-list.pdf");
  await writeFile(file, bytes);
  // Xpdf and poppler both print their version to stderr; Xpdf exits non-zero for -v.
  const probe = spawnSync("pdftotext", ["-v"], { encoding: "utf8" });
  const version = `${probe.stderr ?? ""}${probe.stdout ?? ""}`.trim() || "pdftotext";
  // Windows builds write CRLF; the fixture is kept as LF so it is byte-identical on every platform.
  const text = res.ok ? toLf(execFileSync("pdftotext", ["-raw", "-enc", "UTF-8", file, "-"], { encoding: "utf8" })) : "";
  return {
    url, status: res.status, finalUrl: res.url || url, sha256: sha256(bytes), bytes: bytes.length,
    extractor: `pdftotext -raw -enc UTF-8 (${version.split(/\r?\n/)[0]})`, text
  };
}

describe.skipIf(mode !== "live" && mode !== "raw")("diagram source probe (local only)", () => {
  it("captures each case and proves its minimized fixtures replay to the same evidence", async () => {
    const live = createFetcher({ concurrency: 1, minGapMs: 2000, timeoutMs: 20_000 });
    const summary = [];
    for (const c of DIAGRAM_CASES.filter((x) => !only?.length || only.includes(x.id))) {
      const rawDir = path.join(RAW_ROOT, c.id);
      await mkdir(rawDir, { recursive: true });
      let source: Fetcher = live;
      let capturedAt = new Date();
      let oem: OemCapture | undefined;
      if (mode === "raw") {
        const raw = JSON.parse(await readFile(path.join(rawDir, "raw-manifest.json"), "utf8")) as RawManifest;
        capturedAt = new Date(raw.capturedAt);
        source = replayFetcher(await Promise.all(raw.fetches.map(async (f) => ({ ...f, html: await readFile(path.join(rawDir, f.file), "utf8") }))));
        if (raw.oem) {
          const { file, ...meta } = raw.oem;
          oem = { ...meta, text: toLf(await readFile(path.join(rawDir, file), "utf8")) };
        }
      } else if (c.oemPartsList) {
        oem = await captureOemPdf(c.oemPartsList, rawDir);
      }
      const log: Array<{ requested: string; res: FetchResult }> = [];
      const recording: Fetcher = async (url) => {
        const res = await source(url);
        log.push({ requested: url, res });
        return res;
      };
      const result = await runDiagramCase(c, recording, capturedAt, oem);

      const fetches: ManifestFetch[] = [];
      const files = new Map<string, string>();
      const rawFetches: RawManifest["fetches"] = [];
      for (const [i, { requested, res }] of log.entries()) {
        const name = `${String(i + 1).padStart(2, "0")}-${slug(res.finalUrl)}.html`;
        if (mode === "live") await writeFile(path.join(rawDir, name), res.html);
        rawFetches.push({ requested, status: res.status, finalUrl: res.finalUrl, file: name });
        // A network failure carries only the error text, which replays as-is.
        const minimized = !res.html ? "" : res.status === 0 ? res.html : minimizeDiagramPage(res.html);
        if (minimized) files.set(name, minimized);
        fetches.push({ requested, status: res.status, finalUrl: res.finalUrl, fixture: minimized ? name : null, rawBytes: Buffer.byteLength(res.html), rawSha256: sha256(res.html) });
      }
      if (mode === "live") {
        let rawOem: RawManifest["oem"];
        if (oem) {
          await writeFile(path.join(rawDir, "oem-parts-list.txt"), oem.text);
          const { text: _text, ...meta } = oem;
          rawOem = { ...meta, file: "oem-parts-list.txt" };
        }
        const raw: RawManifest = { capturedAt: capturedAt.toISOString(), fetches: rawFetches, oem: rawOem };
        await writeFile(path.join(rawDir, "raw-manifest.json"), `${JSON.stringify(raw, null, 2)}\n`);
      }

      const replay = await runDiagramCase(
        c, replayFetcher(fetches.map((f) => ({ ...f, html: f.fixture ? files.get(f.fixture)! : "" }))), capturedAt, oem
      );
      expect(replay).toEqual(result);

      if (writeFixtures) {
        const dir = path.join(FIXTURE_ROOT, c.id);
        await mkdir(dir, { recursive: true });
        for (const [name, html] of files) await writeFile(path.join(dir, name), html);
        const manifest: CaseManifest = {
          case: c.id, capturedAt: capturedAt.toISOString(),
          method: "GET via src/sources/http createFetcher (1 in flight per host, 2 s between starts, 20 s timeout, no retries); pages minimized by test/diagram-sources-support.ts",
          fetches
        };
        if (oem) {
          await writeFile(path.join(dir, "oem-parts-list.txt"), oem.text);
          const { text: _text, ...meta } = oem;
          manifest.oemPartsList = { ...meta, fixture: "oem-parts-list.txt" };
        }
        await writeFile(path.join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
      }
      summary.push(...matrixRows([result]));
    }
    console.table(summary.map((r) => ({
      case: r.case, provider: r.provider, sections: `${r.retrievedSections}/${r.expectedSections ?? "?"}`, rows: r.retrievedRows, outcome: r.outcome, reason: r.reason.slice(0, 100)
    })));
  }, 900_000);
});

/**
 * Source-only fixtures from pages captured by hand (for example during reconnaissance, when the scripted probe is
 * refused). The raw pages stay outside the repository; DIAGRAM_SOURCE_ONLY_DIR names their folder and its index.json
 * (SourceOnlyCapture[]). Each page is minimized only after every parser and identity check reads it the same way.
 *
 *   DIAGRAM_SOURCE_ONLY_DIR=/path/to/raw npx vitest run test/diagram-source-probe.local.test.ts
 */
const sourceOnlyDir = process.env.DIAGRAM_SOURCE_ONLY_DIR;

describe.skipIf(!sourceOnlyDir)("source-only diagram fixtures (local only)", () => {
  it("minimizes each listed capture without changing what the parsers read", async () => {
    const index = JSON.parse(await readFile(path.join(sourceOnlyDir!, "index.json"), "utf8")) as Array<SourceOnlyCapture & { file: string }>;
    const out = path.join(FIXTURE_ROOT, "source-only");
    await mkdir(out, { recursive: true });
    const provenance: SourceOnlyCapture[] = [];
    for (const { file, ...entry } of index) {
      const raw = await readFile(path.join(sourceOnlyDir!, file), "utf8");
      const minimized = minimizeDiagramPage(raw);
      expect(readEveryWay(entry, minimized)).toEqual(readEveryWay(entry, raw));
      await writeFile(path.join(out, entry.fixture), minimized);
      provenance.push({ ...entry, rawBytes: Buffer.byteLength(raw), rawSha256: sha256(raw) });
    }
    await writeFile(path.join(out, "provenance.json"), `${JSON.stringify(provenance, null, 2)}
`);
  });
});
