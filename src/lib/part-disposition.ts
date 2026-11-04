/**
 * Where a pulled part goes (owner decision 2026-11-04). Failed and Missing are unchanged.
 *
 *   Pulled  -> eBay | Repair (recipient fleet Machine ID)
 *   eBay    -> Listed | Sold (price)
 *   Listed  -> Unlisted | Sold (price)
 *   Unlisted clears the part state: the part counts as on the machine again (no storage area yet).
 *
 * Undo steps back one level: Sold -> Listed (or eBay if never listed) -> eBay -> Pulled -> cleared;
 * Repair -> Pulled.
 */
export const DISPOSITIONS = ["ebay", "listed", "sold", "repair"] as const;
export type Disposition = (typeof DISPOSITIONS)[number];
export type DispositionStep = "ebay" | "repair" | "listed" | "sold" | "unlisted" | "back";

export interface DispositionRecord {
  disposition: Disposition | null;
  listedAt: Date | null;
  soldPrice: string | null;
  repairMachineNo: string | null;
}

export type Transition =
  | { kind: "update"; record: DispositionRecord }
  | { kind: "clear" }
  | { kind: "invalid"; reason: "step" | "price" | "machine" };

export const DISPOSITION_LABEL: Record<Disposition, string> = { ebay: "eBay", listed: "eBay listed", sold: "sold", repair: "repair" };

/** Forward steps offered from a pulled part's current disposition (undo is always offered). */
export function nextSteps(d: Disposition | null): DispositionStep[] {
  if (d === null) return ["ebay", "repair"];
  if (d === "ebay") return ["listed", "sold"];
  if (d === "listed") return ["unlisted", "sold"];
  return [];
}

export function isDisposition(v: unknown): v is Disposition {
  return typeof v === "string" && (DISPOSITIONS as readonly string[]).includes(v);
}

/** "$1,234.5" -> "1234.50". Null when blank, negative, not a number, or too large for numeric(10,2). */
export function parseSoldPrice(raw: string | null | undefined): string | null {
  const s = String(raw ?? "").replace(/[$,\s]/g, "");
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(s)) return null;
  const n = Math.round(Number(s) * 100) / 100;
  if (!Number.isFinite(n) || n < 0 || n >= 1e8) return null;
  return n.toFixed(2);
}

/** "#6171 " -> "6171". Null when blank. */
export function normalizeMachineNo(raw: string | null | undefined): string | null {
  const s = String(raw ?? "").trim().replace(/^#\s*/, "").trim();
  return s ? s : null;
}

const EMPTY: DispositionRecord = { disposition: null, listedAt: null, soldPrice: null, repairMachineNo: null };

export function applyStep(
  cur: DispositionRecord,
  step: DispositionStep,
  input: { soldPrice?: string | null; repairMachineNo?: string | null; now: Date }
): Transition {
  const d = cur.disposition;
  if (step === "back") {
    if (d === null) return { kind: "clear" };
    if (d === "ebay" || d === "repair") return { kind: "update", record: EMPTY };
    if (d === "listed") return { kind: "update", record: { ...EMPTY, disposition: "ebay" } };
    return { kind: "update", record: { ...EMPTY, disposition: cur.listedAt ? "listed" : "ebay", listedAt: cur.listedAt } };
  }
  if (!nextSteps(d).includes(step)) return { kind: "invalid", reason: "step" };
  if (step === "unlisted") return { kind: "clear" };
  if (step === "ebay") return { kind: "update", record: { ...EMPTY, disposition: "ebay" } };
  if (step === "listed") return { kind: "update", record: { ...EMPTY, disposition: "listed", listedAt: input.now } };
  if (step === "repair") {
    const machine = normalizeMachineNo(input.repairMachineNo);
    return machine ? { kind: "update", record: { ...EMPTY, disposition: "repair", repairMachineNo: machine } } : { kind: "invalid", reason: "machine" };
  }
  const price = parseSoldPrice(input.soldPrice);
  if (price === null) return { kind: "invalid", reason: "price" };
  return { kind: "update", record: { ...EMPTY, disposition: "sold", soldPrice: price, listedAt: d === "listed" ? cur.listedAt : null } };
}
