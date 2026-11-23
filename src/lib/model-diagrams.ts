import { canonicalizeMpn } from "./mpn";

export type DiagramPart = { callout: string; partNumber: string; description: string };

export type ModelDiagramSection = {
  assembly: string;
  imageUrl: string;
  note: string;
  parts: DiagramPart[];
};

/**
 * The role a part number plays at a callout. Each is separate evidence: a supplier printing another number at the
 * same callout, or a part found on one machine, never re-keys the catalog number.
 */
export type CalloutRole = "catalog" | "supplier_listed" | "replacement" | "observed";

export type CalloutRecord = {
  /** The displayed section this callout belongs to. */
  assembly: string;
  callout: string;
  /** Exactly as the source printed it. */
  partNumber: string;
  role: CalloutRole;
  evidence: string;
  sourceUrl: string | null;
  /** Set when the record is about one machine only (a part physically read there); null for the model. */
  machineNo: string | null;
};

export type ModelDiagrams = {
  sourceUrl: string;
  sourceNote: string;
  sections: ModelDiagramSection[];
  /** Link label for sourceUrl. Workbook imports predate it and are Encompass. */
  sourceLabel?: string;
  calloutRecords?: CalloutRecord[];
};

/** Model-wide records plus those about this machine; another machine's observations are never shown as this one's. */
export function calloutRecordsFor(evidence: ModelDiagrams, machineNo: string): CalloutRecord[] {
  return (evidence.calloutRecords ?? []).filter((r) => r.machineNo === null || r.machineNo === machineNo);
}

export type DiagramReference = { assembly: string; imageUrl: string; callout: string };

/** Keep the full nameplate spelling, including the engineering suffix and its separator. */
export function exactDiagramModel(model: string) {
  return model.trim().toUpperCase();
}

export function diagramReferencesByMpn(sections: ModelDiagramSection[]) {
  const byMpn = new Map<string, DiagramReference[]>();
  for (const { assembly, imageUrl, parts } of sections) {
    for (const { callout, partNumber } of parts) {
      const key = canonicalizeMpn(partNumber);
      const references = byMpn.get(key) ?? [];
      references.push({ assembly, imageUrl, callout });
      byMpn.set(key, references);
    }
  }
  return byMpn;
}
