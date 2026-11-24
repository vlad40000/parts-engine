export type PartScope = {
  brand: string;
  /** Full nameplate model, including punctuation, variant and engineering suffix. */
  model: string;
  /** Diagram slot or other unambiguous component identifier within that model. */
  component: string;
};

export type OemSource = {
  id: string;
  kind: "oem_serial_document" | "oem_historical_bom" | "oem_model_diagram"
    | "specialist_distributor" | "reseller" | "archive_capture";
  url: string;
  upstreamId?: string;
  documentDate?: string;
  capturedOn?: string;
  detail?: string;
};

export type OriginalMpnEvidence = {
  kind: "original";
  scope: PartScope;
  mpn: string;
  source: OemSource;
  applicability?: {
    /** Each condition applies. Use separate rows for alternative sets of conditions. */
    notes: readonly string[];
    /** Reviewed against the document's exact model, slot, original MPN and applicability text. */
    validated: boolean;
  };
};

export type ServiceReplacementEvidence = {
  kind: "replacement";
  /** A catalog edge for an exact part, or an MPN-to-MPN cross-reference for the brand. */
  scope: PartScope | { brand: string; model?: never; component?: never };
  fromMpn: string;
  toMpn: string;
  source: OemSource;
  restriction?: string;
};

/** A supplier's claimed association to a marking is evidence about the marking only. */
export type MarkingClaim = {
  kind: "marking_claim";
  brand: string;
  marking: string;
  mpn: string;
  source: OemSource;
};

export type OemEvidence = OriginalMpnEvidence | ServiceReplacementEvidence | MarkingClaim;
