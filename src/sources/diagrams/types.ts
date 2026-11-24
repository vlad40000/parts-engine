import type { FetchResult } from "../types";

/**
 * Exact-model assembly diagram evidence, read-only. One attempt is one provider asked about one
 * brand + full model (+ manufacturer variation where the maker uses one). Nothing here writes to the
 * database: an attempt is a reviewable record of what a source published and how much of it was read.
 */
export type DiagramProvider = "appliancepartspros" | "encompass" | "homedepot" | "oem-parts-list";

/**
 * complete: the exact identity was confirmed and every section the source publishes for it was read.
 * This is completeness against that source, not proof of the installed OEM BOM.
 * partial: identity confirmed, some published sections missing (each listed with its reason).
 * blocked: nothing usable: access refused, page missing, identity unproven or for another model.
 */
export type DiagramOutcome = "complete" | "partial" | "blocked";

export type DiagramQuery = { brand: string; model: string; variation?: string | null };

/** One part line at a callout, as published. Retail ids (AP…, HD…) are never stored as MPNs. */
export type DiagramCallout = {
  /** The label printed on the drawing and in the key: "10", "1A", "F032". Always a string. */
  callout: string;
  /** The part number exactly as the source printed it (trimmed). */
  supplierMpn: string;
  /** D1 key: upper-case, every non-[A-Z0-9] character removed. Derived, never replaces supplierMpn. */
  mpnKey: string;
  description: string;
  supplierPartId: string | null;
  /** A sub-row under one callout, such as a finish ("White") or a literature item ("Owners Manual"). */
  variantLabel: string | null;
};

export type DiagramSection = {
  assembly: string;
  /** Where the rows were read: a section page, or a PDF page anchor. */
  sourcePageUrl: string;
  /** Full-size drawing. Null when the source publishes the section without one. */
  diagramUrl: string | null;
  /** False for a legitimately unillustrated section (optional parts, accessories). */
  illustrated: boolean;
  callouts: DiagramCallout[];
  /** Rows the source listed in the section with no callout label (featured accessories, optional parts). */
  uncalloutedRows: Array<Omit<DiagramCallout, "callout">>;
  /** Exact repeats (same callout, MPN and retail id) listed twice by the source and kept once. */
  duplicateRows: number;
  /** Rows listed without a readable OEM number: kept with their callout so the gap is visible, never guessed. */
  unreadRows: UnreadRow[];
};

export type UnreadRow = { callout: string; supplierPartId: string | null; description: string; reason: string };

export type FetchOutcome = "read" | "blocked" | "missing" | "failed" | "refused" | "skipped";

export type FetchRecord = {
  url: string;
  status: number;
  finalUrl: string;
  outcome: FetchOutcome;
  note: string | null;
};

export type DiagramAttempt = {
  provider: DiagramProvider;
  brand: string;
  /** Full model with revision exactly as queried. */
  model: string;
  variation: string | null;
  /** The confirmed landing page, or null when none was confirmed. */
  sourceUrl: string | null;
  retrievedAt: string;
  /** What proved, or refused, the exact identity. */
  identity: string;
  expectedSections: number | null;
  retrievedSections: number;
  /** Callout rows the source declares, when it declares a count. */
  expectedRows: number | null;
  retrievedRows: number;
  sections: DiagramSection[];
  /** Each published section or page that was not read, with the reason. */
  missing: string[];
  fetches: FetchRecord[];
  outcome: DiagramOutcome;
  reason: string;
};

export type { FetchResult };
