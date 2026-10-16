import { lookupAppliancePartsPros } from "./appliancepartspros";
import { lookupEncompass } from "./encompass";
import { lookupPartsDr } from "./partsdr";
import { lookupPartSelect } from "./partselect";
import type { BomSource } from "./selection";
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
];
const ALTERNATIVES = [
  { name: "partsdr", run: lookupPartsDr },
  { name: "partselect", run: lookupPartSelect }
];

/** HTML-only chain. No Gemini. First supplier with ≥ MIN_BOM_ROWS wins. */
export async function lookupModelBom(q: ModelQuery, fetcher: Fetcher, source: BomSource = "auto"): Promise<ChainResult> {
  const attempts: ChainResult["attempts"] = [];
  let sawError = false;
  const suppliers = source === "auto" ? SUPPLIERS : source === "alternatives" ? ALTERNATIVES : ALTERNATIVES.filter((s) => s.name === source);
  for (const s of suppliers) {
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
  // One website's miss does not exhaust the other suppliers or remove a model from Retries.
  if (source !== "auto" && attempts.length) attempts.at(-1)!.warnings.push("No complete parts list verified by this selection; the model remains available for another retry source.");
  return { status: sawError || source !== "auto" ? "error" : "not_found", winner: null, attempts };
}
