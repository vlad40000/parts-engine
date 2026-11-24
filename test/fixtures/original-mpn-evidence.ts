import type { OemEvidence, PartScope } from "@/src/lib/oem-evidence";

// The catalog example is known. The machine that supplied the photographed PCB is unknown.
export const GE_CONTROL: PartScope = { brand: "GE", model: "GTW540ASP0WS", component: "35" };
export const GE_MARKING = "290D2226G003";
const geDiagram = {
  id: "ge-gtw540asp0ws-controls",
  kind: "oem_model_diagram",
  url: "https://www.geapplianceparts.com/store/parts/ModelSectionParts/GTW540ASP0WS/1/0/0/0/CONTROLS_%26_BACKSPLASH",
  detail: "Controls & Backsplash, reference 35: WH22X32357, replaced by WH22X38441."
} as const;
const supplierReplacement = {
  id: "virginia-service-supply-wh22x38441c",
  kind: "reseller",
  url: "https://www.virginiaservicesupply.com/products/ge-wh22x38441-main-control-board"
} as const;

export const GE_EVIDENCE: readonly OemEvidence[] = [
  { kind: "original", scope: GE_CONTROL, mpn: "WH22X32357", source: geDiagram },
  { kind: "replacement", scope: GE_CONTROL, fromMpn: "WH22X32357", toMpn: "WH22X38441", source: geDiagram },
  ...["WH22X32357", "WH18X28174"].map((fromMpn) => ({
    kind: "replacement" as const, scope: { brand: "GE" }, fromMpn, toMpn: "WH22X38441C", source: supplierReplacement
  })),
  {
    kind: "marking_claim", brand: "GE", marking: GE_MARKING, mpn: "WH22X32357",
    source: {
      id: "certified-parts-290d2226g003", kind: "reseller",
      url: "https://www.certified-parts.com/wh22x32357-ge-washer-power-control-board-main-circuit-290d2226g003"
    }
  },
  {
    kind: "marking_claim", brand: "GE", marking: GE_MARKING, mpn: "WH18X28174",
    source: {
      id: "shopjimmy-gtw220ack6ww", kind: "reseller",
      url: "https://www.shopjimmy.com/categories/brands/ge/gtw220ack6ww.html?limit=24",
      detail: "This catalog separately associates WH22X32357 with 290D1914G101 and 290D1914G001."
    }
  }
];

// Invented model, MPNs, serials and bulletin. These illustrate an explicitly documented split.
export const SYNTHETIC_CONTROL: PartScope = { brand: "GE", model: "EXAMPLE.01", component: "control-1" };
export const SYNTHETIC_BREAK: readonly OemEvidence[] = [
  {
    kind: "original", scope: SYNTHETIC_CONTROL, mpn: "TEST-A", source: {
      id: "synthetic-break", kind: "oem_serial_document", url: "https://example.invalid/ge-serial-break"
    },
    applicability: { validated: true, notes: ["Before serial SL200000Q"] }
  },
  {
    kind: "original", scope: SYNTHETIC_CONTROL, mpn: "TEST-B", source: {
      id: "synthetic-break", kind: "oem_serial_document", url: "https://example.invalid/ge-serial-break"
    },
    applicability: { validated: true, notes: ["Starting with serial SL200000Q"] }
  }
];
