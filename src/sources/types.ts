export type FetchResult = { ok: boolean; status: number; finalUrl: string; html: string };
export type Fetcher = (url: string) => Promise<FetchResult>;

/** One BOM line, already keyed for cross-app matching. */
export type SupplierRow = {
  mpnDisplay: string;
  mpnCanonical: string;
  description: string;
  diagramId: string;
  supplierPartId: string | null;
  newPrice: number | null;
  nla: boolean;
};

export type SupplierResult = {
  supplier: string;
  status: "found" | "not_found" | "error";
  rows: SupplierRow[];
  /** Rows the supplier listed but without a usable OEM number (never guessed). */
  droppedRows: number;
  sourceUrl: string | null;
  visited: string[];
  warnings: string[];
  elapsedMs: number;
};

export type ModelQuery = { brand: string; model: string };
