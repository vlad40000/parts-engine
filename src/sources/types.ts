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
  /**
   * found: these rows are the requested model's parts. not_found: the supplier says it has no parts
   * list for it (no page, or its own page for this model lists none). mismatch: the supplier offered a
   * page that is not provably this brand + model (a redirect to another model or maker, a catalog page
   * that names no model, a model with unread characters); nothing from it is read. error: the lookup
   * could not be completed, including an answer that cannot be identified as either.
   */
  status: "found" | "not_found" | "mismatch" | "error";
  rows: SupplierRow[];
  /** Rows the supplier listed but without a usable OEM number (never guessed). */
  droppedRows: number;
  sourceUrl: string | null;
  visited: string[];
  warnings: string[];
  elapsedMs: number;
};

export type ModelQuery = { brand: string; model: string };
