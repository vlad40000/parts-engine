/**
 * Serial → candidate manufacture years.
 *
 * Rules are ported from the executable Fix decoder tables documented in
 * Machine_Age_Determination_For_Agent.docx (App 1, lib/tools/parts/serial/decoder.js).
 *
 * Difference from App 1, on purpose: this decoder NEVER collapses ambiguity to the
 * newest year. It returns every candidate. Age bands use all of them, so an
 * ambiguous machine belongs to every band any candidate falls in.
 */

export type SerialFamily =
  | "GE"
  | "WHIRLPOOL"
  | "MAYTAG_LEGACY"
  | "ELECTROLUX"
  | "LG"
  | "SAMSUNG"
  | "BOSCH"
  | "ALLIANCE";

export type SerialDecode = {
  family: SerialFamily | null;
  candidateYears: number[];
  month: number | null;
  week: number | null;
  confidence: "unique" | "ambiguous" | "none";
  note: string;
};

const GE_MONTH: Record<string, number> = {
  A: 1, D: 2, F: 3, G: 4, H: 5, L: 6, M: 7, R: 8, S: 9, T: 10, V: 11, Z: 12
};

const GE_YEAR: Record<string, number[]> = {
  A: [1977, 1989, 2001, 2013, 2025],
  D: [1978, 1990, 2002, 2014, 2026],
  F: [1979, 1991, 2003, 2015],
  G: [1980, 1992, 2004, 2016],
  H: [1981, 1993, 2005, 2017],
  L: [1982, 1994, 2006, 2018],
  M: [1983, 1995, 2007, 2019],
  R: [1984, 1996, 2008, 2020],
  S: [1985, 1997, 2009, 2021],
  T: [1986, 1998, 2010, 2022],
  V: [1987, 1999, 2011, 2023],
  Z: [1988, 2000, 2012, 2024]
};

const WHIRLPOOL_YEAR: Record<string, number[]> = {
  K: [2000], L: [2001], M: [2002], P: [2003], R: [2004], S: [2005], T: [2006], U: [2007], W: [2008], Y: [2009],
  A: [1991, 2021], B: [1992, 2022], C: [1993, 2023], D: [1994, 2024],
  E: [1995], F: [1996], G: [1997], H: [1998], J: [1999],
  "0": [1980, 2010], "1": [1981, 2011], "2": [1982, 2012], "3": [1983, 2013], "4": [1984, 2014],
  "5": [1985, 2015], "6": [1986, 2016], "7": [1987, 2017], "8": [1988, 2018], "9": [1989, 2019]
};

const MAYTAG_YEAR: Record<string, number[]> = {
  A: [1978, 2002], B: [1966, 1990, 2014], C: [1979, 2003], D: [1967, 1991], E: [1980, 2004],
  F: [1968, 1992], G: [1981, 2005], H: [1969, 1993], J: [1982, 2006], K: [1970, 1994],
  L: [1983, 2007], M: [1971, 1995], N: [1980, 2008], P: [1985, 2009], Q: [1972, 1996],
  R: [1986, 2010], S: [1973, 1997], T: [1987, 2011], U: [1974, 1998], V: [1988, 2012],
  W: [1975, 1999], X: [1989, 2013], Y: [1976, 2000], Z: [1977, 2001]
};

const SAMSUNG_YEAR: Record<string, number[]> = {
  R: [2001, 2021], T: [2002, 2022], W: [2003, 2023], X: [2004, 2024], Y: [2005],
  A: [2006], L: [2006], P: [2007], Q: [2008], S: [2009], Z: [2010], B: [2011],
  C: [2012], D: [2013], E: [2014], G: [2015], H: [2016], J: [2017], K: [2018],
  M: [2019], N: [2020]
};

const SAMSUNG_MONTH: Record<string, number> = {
  "1": 1, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9, A: 10, B: 11, C: 12
};

const BRAND_FAMILY: Record<string, SerialFamily> = {
  GE: "GE", "GENERAL ELECTRIC": "GE", HOTPOINT: "GE", HAIER: "GE", MONOGRAM: "GE", CAFE: "GE", "GE PROFILE": "GE", PROFILE: "GE",
  WHIRLPOOL: "WHIRLPOOL", KITCHENAID: "WHIRLPOOL", AMANA: "WHIRLPOOL", ROPER: "WHIRLPOOL", ESTATE: "WHIRLPOOL",
  ADMIRAL: "WHIRLPOOL", INGLIS: "WHIRLPOOL", "JENN-AIR": "WHIRLPOOL", JENNAIR: "WHIRLPOOL", "JENN AIR": "WHIRLPOOL",
  MAYTAG: "WHIRLPOOL",
  FRIGIDAIRE: "ELECTROLUX", ELECTROLUX: "ELECTROLUX", TAPPAN: "ELECTROLUX", KELVINATOR: "ELECTROLUX", GIBSON: "ELECTROLUX",
  "WHITE-WESTINGHOUSE": "ELECTROLUX", "WHITE WESTINGHOUSE": "ELECTROLUX",
  LG: "LG", GOLDSTAR: "LG",
  SAMSUNG: "SAMSUNG", DACOR: "SAMSUNG",
  BOSCH: "BOSCH", THERMADOR: "BOSCH", GAGGENAU: "BOSCH",
  "SPEED QUEEN": "ALLIANCE", SPEEDQUEEN: "ALLIANCE", HUEBSCH: "ALLIANCE", ALLIANCE: "ALLIANCE"
};

/** Kenmore has no date code of its own; route by the model's 3-digit OEM prefix. */
const KENMORE_PREFIX: Record<string, SerialFamily> = {
  "106": "WHIRLPOOL", "110": "WHIRLPOOL", "665": "WHIRLPOOL",
  "587": "ELECTROLUX", "253": "ELECTROLUX", "417": "ELECTROLUX",
  "795": "LG", "796": "LG",
  "401": "SAMSUNG", "592": "SAMSUNG",
  "363": "GE", "362": "GE", "911": "GE"
};

export function normalizeSerial(raw: string | null | undefined): string {
  return (raw ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/^(SERIAL|SER|SN)(?=[A-Z0-9]{6,})/, "");
}

export function resolveFamily(brand: string, model: string): SerialFamily | null {
  const b = brand.trim().toUpperCase();
  if (b === "KENMORE" || b === "KENMORE ELITE" || b === "SEARS") {
    const prefix = model.trim().match(/^(\d{3})/)?.[1];
    return prefix ? KENMORE_PREFIX[prefix] ?? null : null;
  }
  const family = BRAND_FAMILY[b] ?? null;
  if (family === "WHIRLPOOL" && b === "MAYTAG" && /\d{4}[A-Z]{2}$/.test(model.trim().toUpperCase())) {
    return "MAYTAG_LEGACY";
  }
  return family;
}

function result(
  family: SerialFamily | null,
  years: number[],
  maxYear: number,
  month: number | null,
  week: number | null,
  note: string
): SerialDecode {
  const candidateYears = [...new Set(years.filter((y) => y <= maxYear))].sort((a, b) => a - b);
  return {
    family,
    candidateYears,
    month,
    week,
    confidence: candidateYears.length === 0 ? "none" : candidateYears.length === 1 ? "unique" : "ambiguous",
    note: candidateYears.length === 0 ? `No ${family ?? "known"} pattern matched.` : note
  };
}

function decades(digit: number): number[] {
  return [1990 + digit, 2000 + digit, 2010 + digit, 2020 + digit];
}

export function decodeSerial(
  brand: string,
  model: string,
  rawSerial: string,
  now: Date = new Date()
): SerialDecode {
  const maxYear = now.getFullYear();
  const serial = normalizeSerial(rawSerial);
  const family = resolveFamily(brand, model);
  const none = (note: string): SerialDecode => ({ family, candidateYears: [], month: null, week: null, confidence: "none", note });

  if (!serial) return none("No serial.");
  if (!family) return none(`No serial rule for brand "${brand}".`);

  switch (family) {
    case "GE": {
      const m = serial.match(/^([ADFGHLMRSTVZ])([ADFGHLMRSTVZ])/);
      if (!m) return none("GE serial must start with a month letter and a year letter.");
      return result(family, GE_YEAR[m[2]] ?? [], maxYear, GE_MONTH[m[1]] ?? null, null, `GE month ${m[1]}, year code ${m[2]}.`);
    }
    case "WHIRLPOOL": {
      const m = serial.match(/^[A-Z0-9]([A-Z0-9])(\d{2})[A-Z0-9]{5,}$/);
      if (!m) return none("Whirlpool serial pattern not matched.");
      const week = Number(m[2]);
      if (week < 1 || week > 53) return none("Whirlpool week out of range.");
      const years = WHIRLPOOL_YEAR[m[1]];
      if (!years) return none(`Whirlpool year code ${m[1]} unknown.`);
      return result(family, years, maxYear, null, week, `Whirlpool year code ${m[1]}, week ${week}.`);
    }
    case "MAYTAG_LEGACY": {
      const yearCode = serial.at(-2) ?? "";
      const years = MAYTAG_YEAR[yearCode];
      if (!years) return none("Maytag legacy year code not matched.");
      return result(family, years, maxYear, null, null, `Maytag legacy year code ${yearCode}.`);
    }
    case "ELECTROLUX": {
      const m = serial.match(/^[A-Z0-9]{2}(\d)(\d{2})/);
      if (!m) return none("Electrolux serial pattern not matched.");
      const week = Number(m[2]);
      if (week < 1 || week > 53) return none("Electrolux week out of range.");
      return result(family, decades(Number(m[1])), maxYear, null, week, `Electrolux year digit ${m[1]}, week ${week}.`);
    }
    case "LG": {
      const m = serial.match(/^(\d)(\d{2})/);
      if (!m) return none("LG serial pattern not matched.");
      const v = Number(m[2]);
      const month = v >= 1 && v <= 12 ? v : null;
      const week = month === null && v >= 1 && v <= 53 ? v : null;
      if (month === null && week === null) return none("LG month/week out of range.");
      return result(family, decades(Number(m[1])), maxYear, month, week, `LG year digit ${m[1]}, ${month ? `month ${month}` : `week ${week}`}.`);
    }
    case "SAMSUNG": {
      const pos = serial.length >= 15 ? 7 : serial.length >= 11 ? 3 : -1;
      if (pos < 0) return none("Samsung serial too short.");
      const yearCode = serial[pos];
      const years = SAMSUNG_YEAR[yearCode];
      if (!years) return none(`Samsung year code ${yearCode} unknown.`);
      return result(family, years, maxYear, SAMSUNG_MONTH[serial[pos + 1]] ?? null, null, `Samsung year code ${yearCode}.`);
    }
    case "BOSCH": {
      const m = serial.match(/^FD(\d{2})(\d{2})/);
      if (!m) return none("Bosch FD code not found.");
      const base = Number(m[1]) + 20;
      const month = Number(m[2]);
      const years = [1900 + base, 2000 + base].filter((y) => y >= 1984);
      return result(family, years, maxYear, month >= 1 && month <= 12 ? month : null, null, `Bosch FD${m[1]}${m[2]}.`);
    }
    case "ALLIANCE": {
      const m = serial.match(/^(\d{2})(\d{2})/);
      if (!m) return none("Alliance YYMM not found.");
      const yy = Number(m[1]);
      const month = Number(m[2]);
      const start = Math.max(1990, maxYear - 45 + 1);
      const years: number[] = [];
      for (let y = start; y <= maxYear; y += 1) if (y % 100 === yy) years.push(y);
      return result(family, years, maxYear, month >= 1 && month <= 12 ? month : null, null, `Alliance YYMM ${m[1]}${m[2]}.`);
    }
  }
}

// ---------------------------------------------------------------------------
// Age bands. Research priority only — never an exclusion gate.
// ---------------------------------------------------------------------------
export type AgeBand = { key: string; label: string; start: number; end: number };

export const DEFAULT_AGE_BANDS: AgeBand[] = [
  { key: "2020+", label: "2020 and newer", start: 2020, end: 9999 },
  { key: "2015-2019", label: "2015–2019", start: 2015, end: 2019 },
  { key: "2010-2014", label: "2010–2014", start: 2010, end: 2014 },
  { key: "2005-2009", label: "2005–2009", start: 2005, end: 2009 },
  { key: "pre-2005", label: "Before 2005", start: 0, end: 2004 }
];

export function inBand(candidateYears: number[], band: Pick<AgeBand, "start" | "end">): boolean {
  return candidateYears.some((y) => y >= band.start && y <= band.end);
}

export function bandsFor(candidateYears: number[], bands: AgeBand[] = DEFAULT_AGE_BANDS): string[] {
  return bands.filter((b) => inBand(candidateYears, b)).map((b) => b.key);
}
