import { canonicalizeMpn } from "./mpn";

export type DiagramPart = { callout: string; partNumber: string; description: string };

export type ModelDiagramSection = {
  assembly: string;
  imageUrl: string;
  note: string;
  parts: DiagramPart[];
};

export type ModelDiagrams = {
  sourceUrl: string;
  sourceNote: string;
  sections: ModelDiagramSection[];
};

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
