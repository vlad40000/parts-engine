/**
 * Shop vocabulary shared by the printed cards, the card reader prompt and the planner,
 * so a printed card and the reader can never disagree.
 */

export const CARD_CODES = { move: "RR-M1", repair: "RR-R1" } as const;
export type CardCode = (typeof CARD_CODES)[keyof typeof CARD_CODES] | "free";
export const isCardCode = (v: string): v is CardCode => v === "RR-M1" || v === "RR-R1" || v === "free";

/** Status/Move card: up to this many machines share one status and location. */
export const MOVE_CARD_MACHINES = 4;
/** Repair card: part lines. */
export const REPAIR_CARD_PART_LINES = 4;

/** Statuses a tech can set from a card, in printed order. */
export const CARD_STATUSES = [
  { status: "BEING REPAIRED", label: "Being repaired" },
  { status: "NEEDS PARTS", label: "Needs parts" },
  { status: "PARTS ONLY", label: "Parts machine" },
  { status: "READY TO SALE", label: "Ready for sale" },
  { status: "SCRAPPED", label: "Scrap" }
] as const;
export type CardStatus = (typeof CARD_STATUSES)[number]["status"];
export const CARD_STATUS_VALUES: readonly string[] = CARD_STATUSES.map((s) => s.status);
export const isCardStatus = (v: string): v is CardStatus => CARD_STATUS_VALUES.includes(v);
export const statusLabel = (status: string) => CARD_STATUSES.find((s) => s.status === status)?.label ?? status;

/** Statuses that mean the machine has left the lot (matches OFF_LOT in queries). */
export const OFF_LOT_STATUSES = ["SOLD", "SCRAPED", "SCRAPPED"];

/**
 * Inventory condition code for each status, as the inventory workbook pairs them.
 * READY TO SALE is graded A-D instead.
 */
export const CONDITION_FOR_STATUS: Record<string, string> = {
  "UNCHECKED": "U - Unchecked",
  "BEING REPAIRED": "X - Being Repaired",
  "NEEDS PARTS": "E - Needs Parts",
  "PARTS ONLY": "F - Parts Only",
  "PARTS PROGRAM": "P - Parts Program",
  "SCRAPPED": "S - Scraped"
};

export const SALE_GRADES = [
  { grade: "A", condition: "A - Excellent" },
  { grade: "B", condition: "B - Good" },
  { grade: "C", condition: "C - Fair" },
  { grade: "D", condition: "D - Bad" }
] as const;
export type SaleGrade = (typeof SALE_GRADES)[number]["grade"];
export const gradeCondition = (grade: string) => SALE_GRADES.find((g) => g.grade === grade)?.condition ?? null;
export const isSaleCondition = (condition: string | null | undefined) =>
  SALE_GRADES.some((g) => g.condition === (condition ?? "").trim());

/**
 * Symptom boxes on the repair card. Each phrase is what is written into the diagnosis;
 * the phrases are worded so the existing symptom rules flag the right part families.
 */
export const CARD_SYMPTOMS = [
  { key: "no_power", label: "No power", phrase: "No power." },
  { key: "no_heat", label: "No heat", phrase: "No heat." },
  { key: "not_cooling", label: "Not cooling", phrase: "Not cooling." },
  // Written without the word "gas", which the symptom rules read as gas-burner trouble.
  { key: "needs_refrigerant", label: "Needs gassing", phrase: "Needs refrigerant (sealed system)." },
  { key: "wont_drain", label: "Won't drain", phrase: "Won't drain." },
  { key: "wont_spin", label: "Won't spin", phrase: "Won't spin." },
  { key: "wont_agitate", label: "Won't agitate", phrase: "Won't agitate." },
  { key: "leaks", label: "Leaks", phrase: "Leaks." },
  { key: "noisy", label: "Noisy", phrase: "Noisy." },
  { key: "timer", label: "Timer won't advance", phrase: "Timer won't advance." },
  { key: "door_latch", label: "Door / lid latch", phrase: "Door/lid latch problem." },
  { key: "control", label: "Control / board", phrase: "Control board problem." },
  { key: "dents_rust", label: "Dents / rust", phrase: "Dents/rust." }
] as const;
export type SymptomKey = (typeof CARD_SYMPTOMS)[number]["key"];
export const SYMPTOM_KEYS: readonly string[] = CARD_SYMPTOMS.map((s) => s.key);

/** Locations that are never printed on a card: they record that a machine left the lot. */
export const OFF_CARD_LOCATIONS = ["$$$SOLD$$$", "Scraped"];

/** Location text as the shop writes it, reduced to comparable words. */
export function normalizeLocation(text: string | null | undefined): string {
  return (text ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\bbldg\b/g, "building")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** "red building" → "Red Building" (a name for a new location). */
export function titleCaseLocation(text: string): string {
  return text
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\b([a-z])([a-z]*)/gi, (_, a: string, b: string) => a.toUpperCase() + b.toLowerCase());
}

/** Shop calendar day (cards are dated in local time). */
export const SHOP_TIME_ZONE = "America/New_York";
export function shopToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: SHOP_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** "5/12/26", "05-12-2026", "5.12.26" → "2026-05-12"; null when it is not a real date. */
export function parseCardDate(text: string | null | undefined): string | null {
  const m = /(\d{1,2})\s*[/.\-]\s*(\d{1,2})\s*[/.\-]\s*(\d{2}|\d{4})\b/.exec(text ?? "");
  if (!m) return null;
  const month = Number(m[1]), day = Number(m[2]);
  const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  return isoDate(year, month, day);
}

export function isoDate(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return d.toISOString().slice(0, 10);
}

/** "2026-05-12" → "5/12/26", the date style the inventory's repair notes use. */
export function shortDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${m}/${d}/${String(y).slice(-2)}`;
}
