import type { DiagramAttempt, DiagramCallout, DiagramSection } from "./types";

/**
 * Compare a catalog (OEM parts list) with a supplier's diagram pages for the same exact model, section by section
 * and callout by callout. A supplier usually prints the current service number where the catalog prints the
 * original one, so a different number at the same callout is reported side by side, never merged: supersession is
 * a relationship that needs its own evidence.
 */
export type CalloutComparison = {
  section: string;
  catalogSection: string;
  supplierSection: string;
  /** Whole-number callouts each side lists ("6A" counts as 6). */
  catalogCallouts: number;
  supplierCallouts: number;
  /** Catalog callouts the supplier does not list at all. */
  missingFromSupplier: string[];
  /** Catalog callouts the supplier lists only on rows whose OEM number it does not print readably. */
  unreadAtSupplier: string[];
  notInCatalog: string[];
  /** Callouts where a catalog number and a supplier number share a D1 key. */
  sameNumber: string[];
  /** Callouts where no number is shared: both sides kept as printed. */
  differentNumber: Array<{ callout: string; catalog: string[]; supplier: string[] }>;
  /** For a section the catalog publishes without a drawing: part numbers compared directly. */
  unillustrated: { catalogNumbers: number; supplierNumbers: number; shared: string[]; catalogOnly: string[]; supplierOnly: string[] } | null;
};

export type CalloutReconciliation = {
  sections: CalloutComparison[];
  catalogOnly: string[];
  supplierOnly: string[];
};

/** "02 - Top And Cabinet", "TOP AND CABINET PARTS" and "02 - TOP AND CABINET PARTS" are one section. */
export function sectionKey(title: string): string {
  return title.replace(/^\s*\d+\s*-\s*/, "").replace(/\s+parts\s*$/i, "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

const base = (callout: string) => /^(\d{1,3})[A-Z]?$/i.exec(callout)?.[1] ?? callout.toUpperCase();

function byBase(callouts: DiagramCallout[]) {
  const map = new Map<string, DiagramCallout[]>();
  for (const c of callouts) map.set(base(c.callout), [...(map.get(base(c.callout)) ?? []), c]);
  return map;
}

const order = (a: string, b: string) => (Number(a) - Number(b)) || a.localeCompare(b);

function numbers(section: DiagramSection) {
  return new Map([...section.callouts, ...section.uncalloutedRows].map((r) => [r.mpnKey, r.supplierMpn]));
}

function compare(catalog: DiagramSection, supplier: DiagramSection): CalloutComparison {
  const c = byBase(catalog.callouts);
  const s = byBase(supplier.callouts);
  const unread = new Set(supplier.unreadRows.map((r) => base(r.callout)).filter(Boolean));
  const absent = [...c.keys()].filter((k) => !s.has(k)).sort(order);
  const result: CalloutComparison = {
    section: sectionKey(catalog.assembly), catalogSection: catalog.assembly, supplierSection: supplier.assembly,
    catalogCallouts: c.size, supplierCallouts: s.size,
    missingFromSupplier: absent.filter((k) => !unread.has(k)),
    unreadAtSupplier: absent.filter((k) => unread.has(k)),
    notInCatalog: [...s.keys()].filter((k) => !c.has(k)).sort(order),
    sameNumber: [], differentNumber: [], unillustrated: null
  };
  for (const key of [...c.keys()].filter((k) => s.has(k)).sort(order)) {
    const catalogRows = c.get(key) ?? [];
    const supplierRows = s.get(key) ?? [];
    const keys = new Set(catalogRows.map((r) => r.mpnKey));
    if (supplierRows.some((r) => keys.has(r.mpnKey))) result.sameNumber.push(key);
    else result.differentNumber.push({ callout: key, catalog: catalogRows.map((r) => r.supplierMpn), supplier: supplierRows.map((r) => r.supplierMpn) });
  }
  if (!catalog.illustrated) {
    const a = numbers(catalog);
    const b = numbers(supplier);
    result.unillustrated = {
      catalogNumbers: a.size, supplierNumbers: b.size,
      shared: [...a.keys()].filter((k) => b.has(k)).map((k) => a.get(k)!),
      catalogOnly: [...a.keys()].filter((k) => !b.has(k)).map((k) => a.get(k)!),
      supplierOnly: [...b.keys()].filter((k) => !a.has(k)).map((k) => b.get(k)!)
    };
  }
  return result;
}

export function reconcileCallouts(catalog: DiagramAttempt, supplier: DiagramAttempt): CalloutReconciliation {
  const supplierByKey = new Map(supplier.sections.map((s) => [sectionKey(s.assembly), s]));
  const catalogKeys = new Set(catalog.sections.map((s) => sectionKey(s.assembly)));
  return {
    sections: catalog.sections.flatMap((s) => {
      const match = supplierByKey.get(sectionKey(s.assembly));
      return match ? [compare(s, match)] : [];
    }),
    catalogOnly: catalog.sections.filter((s) => !supplierByKey.has(sectionKey(s.assembly))).map((s) => s.assembly),
    supplierOnly: supplier.sections.filter((s) => !catalogKeys.has(sectionKey(s.assembly))).map((s) => s.assembly)
  };
}
