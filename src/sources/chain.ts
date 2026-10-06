import { lookupAppliancePartsPros } from "./appliancepartspros";
import { lookupEncompass } from "./encompass";
import type { Fetcher, ModelQuery, SupplierResult } from "./types";

/** A supplier result with fewer rows than this is treated as a miss (Ledger MIN_SPINE_THRESHOLD). */
export const MIN_BOM_ROWS = 5;

export type ChainResult = {
  status: "found" | "not_found" | "error";
  winner: SupplierResult | null;
  attempts: Array<Omit<SupplierResult, "rows">>;
};

const SUPPLIERS: Array<{ name: string; run: (q: ModelQuery, f: Fetcher) => Promise<SupplierResult> }> = [
  // 1 request per model, OEM numbers direct, same price source as Ledger's encompass_price.
  { name: "encompass", run: lookupEncompass },
  // 1 + 1 per section. Covers Frigidaire, which Encompass does not list in HTML.
  { name: "appliancepartspros", run: lookupAppliancePartsPros }
  // PartSelect and PartsDr serve static HTML too (verified 2026-10-06) but need
  // raw-HTML fixtures captured with `npm run capture` before parsers are written.
];

/** HTML-only chain. No Gemini. First supplier with ≥ MIN_BOM_ROWS wins. */
export async function lookupModelBom(q: ModelQuery, fetcher: Fetcher): Promise<ChainResult> {
  const attempts: ChainResult["attempts"] = [];
  let sawError = false;
  for (const s of SUPPLIERS) {
    let result: SupplierResult;
    try {
      result = await s.run(q, fetcher);
    } catch (error) {
      result = {
        supplier: s.name, status: "error", rows: [], droppedRows: 0, sourceUrl: null, visited: [],
        warnings: [error instanceof Error ? error.message : String(error)], elapsedMs: 0
      };
    }
    const { rows, ...meta } = result;
    attempts.push(meta);
    if (result.status === "error") sawError = true;
    if (result.status === "found" && rows.length >= MIN_BOM_ROWS) {
      return { status: "found", winner: result, attempts };
    }
    if (result.status === "found") meta.warnings.push(`Only ${rows.length} rows; below ${MIN_BOM_ROWS}, trying next supplier.`);
  }
  return { status: sawError ? "error" : "not_found", winner: null, attempts };
}
