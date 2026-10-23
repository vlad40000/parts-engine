import { load } from "cheerio";
import { canonicalizeMpn, displayMpn } from "@/src/lib/mpn";
import { priceNumber } from "./http";
import { encompassModelCode, encompassPageIdentity, hasPlaceholder } from "./identity";
import type { Fetcher, ModelQuery, SupplierResult, SupplierRow } from "./types";

/**
 * Encompass PartStore — whole model BOM on one page, OEM part numbers direct.
 * Ported from Ledger src/sources/encompass.ts + encompass-parser.ts (deterministic
 * HTML path that Ledger has but never wires up). Changes:
 *   - pagination reads real "/_/N" links instead of any number on the page
 *   - slash models (Samsung/LG "DV45H7000EW/A2") try Encompass's "|" form
 *   - invalid-model page detected
 *   - a redirect to another model's page is never read, nor a page whose HTML names another
 *     model or no model at all
 *   - a catalog with any page failed, invalid, unparseable, not the page asked for, moved to
 *     another model, holding only the visible slice of its list or beyond the page cap is
 *     rejected whole, never saved partially
 */
export const ENCOMPASS_HOST = "https://partstore.encompass.com";

const BRAND_TO_ABV: Record<string, string> = {
  ge: "HOT", "general electric": "HOT", hotpoint: "HOT", monogram: "HOT", cafe: "HOT", haier: "HAI",
  whirlpool: "WHI", maytag: "WHI", kitchenaid: "WHI", "jenn-air": "WHI", jennair: "WHI", amana: "WHI",
  roper: "WHI", estate: "WHI", admiral: "WHI", inglis: "WHI",
  frigidaire: "FRI", electrolux: "FRI", gibson: "FRI", kelvinator: "FRI", tappan: "FRI",
  kenmore: "KMR", "kenmore elite": "KMR",
  lg: "LGE", samsung: "SMG", bosch: "BCH", thermador: "BCH",
  miele: "MIE", "speed queen": "SPQ", speedqueen: "SPQ", viking: "VIK", dacor: "DAC", danby: "DBY"
};

/** Encompass files some Maytag/Whirlpool models under MAY. */
const FALLBACK_ABV: Record<string, string[]> = { WHI: ["MAY"] };

const strip = (s: string) => s.replace(/[^a-z0-9]/gi, "").toUpperCase();

export function encompassModelUrls(brand: string, model: string): string[] {
  const abv = BRAND_TO_ABV[brand.trim().toLowerCase()];
  if (!abv) return [];
  const urls: string[] = [];
  const [base, suffix] = model.trim().split("/");
  const addUrls = (host: string, prefix: string) => {
    if (suffix !== undefined && strip(suffix)) {
      // Verified 2026-10-06: /model/SMGDV45H7000EW%7CA2/0001/ lists the Samsung BOM.
      urls.push(`${host}/model/${prefix}${strip(base)}%7C${strip(suffix)}`);
      urls.push(`${host}/model/${prefix}${strip(base)}%7C${strip(suffix)}/0001/`);
    }
    urls.push(`${host}/model/${prefix}${strip(model)}`);
  };

  // Encompass currently also files LG washer WM2688HWM under ZEN on its main host.
  // Prefer that confirmed identity, retaining the older PartStore LGE route as fallback.
  // Never accept a cross-model redirect, a page without identity, or an incomplete parts list.
  if (abv === "LGE") addUrls("https://encompass.com", "ZEN");
  for (const p of [abv, ...(FALLBACK_ABV[abv] ?? [])]) addUrls(ENCOMPASS_HOST, p);
  return [...new Set(urls)];
}

export function isInvalidModelPage(html: string): boolean {
  return /Invalid-Model|does not exist in our database|Model is not valid for this site/i.test(html);
}

type EncompassPart = {
  allowPurchase?: string;
  location?: string;
  partDescription?: string;
  partNumber?: string;
  partPrice?: string;
  reportPartPrice?: string;
};

function extractJsonArray(value: string, key: string): string | null {
  const marker = `"${key}":[`;
  const markerIndex = value.indexOf(marker);
  if (markerIndex < 0) return null;
  const start = markerIndex + marker.length - 1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < value.length; i += 1) {
    const c = value[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "[") depth += 1;
    else if (c === "]") {
      depth -= 1;
      if (depth === 0) return value.slice(start, i + 1);
    }
  }
  return null;
}

function toRow(partNumber: string, description: string, diagramId: string, priceText: string, nla: boolean): SupplierRow | null {
  const display = displayMpn(partNumber);
  const canonical = canonicalizeMpn(display);
  if (canonical.length < 3) return null;
  return {
    mpnDisplay: display,
    mpnCanonical: canonical,
    description: description.replace(/\s+/g, " ").trim(),
    diagramId: diagramId.trim(),
    supplierPartId: null,
    newPrice: nla ? null : priceNumber(priceText),
    nla
  };
}

/** Rows read from one source of a page, and how many entries that source held before any was dropped. */
type PageRows = { rows: SupplierRow[]; entries: number };

function parseEmbedded(html: string): PageRows {
  const $ = load(html);
  const payloads: string[] = [];
  $("script").each((_, el) => {
    const script = $(el).text();
    const prefix = "self.__next_f.push(";
    const start = script.indexOf(prefix);
    const end = script.lastIndexOf(")");
    if (start < 0 || end <= start) return;
    try {
      const value = JSON.parse(script.slice(start + prefix.length, end)) as unknown;
      if (Array.isArray(value) && typeof value[1] === "string") payloads.push(value[1]);
    } catch {
      /* unrelated inline script */
    }
  });
  for (const candidate of [...payloads, payloads.join("")]) {
    const json = extractJsonArray(candidate, "parts");
    if (!json) continue;
    try {
      const parts = JSON.parse(json) as EncompassPart[];
      return {
        entries: parts.length,
        rows: parts.flatMap((p) => {
          const row = toRow(p.partNumber ?? "", p.partDescription ?? "", p.location ?? "", p.reportPartPrice ?? p.partPrice ?? "", p.allowPurchase === "N");
          return row ? [row] : [];
        })
      };
    } catch {
      /* try next payload */
    }
  }
  return { rows: [], entries: 0 };
}

function parseTable(html: string): PageRows {
  const $ = load(html);
  const table = $("table").filter((_, el) => /Part Number/i.test($(el).text())).first();
  if (!table.length) return { rows: [], entries: 0 };
  const headers = new Map<string, number>();
  table.find("tr").first().find("th,td").each((i, cell) => {
    const name = $(cell).text().replace(/\s+/g, " ").trim().toLowerCase();
    if (name) headers.set(name, i);
  });
  const pn = headers.get("part number");
  const title = headers.get("part title") ?? headers.get("description");
  const price = headers.get("price");
  const avail = headers.get("availability");
  if (pn === undefined || title === undefined) return { rows: [], entries: 0 };

  const rows: SupplierRow[] = [];
  let entries = 0;
  table.find("tr").slice(1).each((_, tr) => {
    const cells = $(tr).find("td,th").toArray();
    if (cells.length <= Math.max(pn, title)) return;
    entries += 1;
    const partNumber = $(cells[pn]).find("b").first().text().trim() || $(cells[pn]).text().trim();
    const lines = ($(cells[title]).html() ?? "")
      .split(/<br\s*\/?>/i)
      .map((l) => load(`<span>${l}</span>`)("span").text().trim())
      .filter(Boolean);
    let diagramId = "";
    const desc: string[] = [];
    for (let line of lines) {
      const m = line.match(/Schematic Location:\s*(\S+)/i);
      if (m) {
        diagramId = m[1] ?? "";
        line = line.replace(/Schematic Location:\s*\S+/i, "").trim();
      }
      if (/^Skill Level/i.test(line)) continue;
      if (line) desc.push(line);
    }
    const availability = avail !== undefined ? $(cells[avail]).text().trim() : "";
    let priceText = price !== undefined ? $(cells[price]).text() : "";
    if (!priceText && avail !== undefined) {
      priceText = $(cells[avail]).find("b").filter((_, el) => /^\d+\.\d{2}$/.test($(el).text().trim())).first().text();
    }
    const nla = /no longer available|discontinued|\bnla\b/i.test(availability);
    const row = toRow(partNumber, desc.join(" "), diagramId, priceText, nla);
    if (row) rows.push(row);
  });
  return { rows, entries };
}

export type EncompassPage = {
  rows: SupplierRow[];
  /** Why these rows are only the visible slice of the page's list, or null when they are all of it. */
  slice: string | null;
};

/**
 * One page's rows. Its HTML table holds only the rows on screen, and its pager says how long the list
 * is: fixture model-page shows 10 rows over 13 "Go to page" buttons and carries all 124 parts in its
 * embedded data; fixture MVWX655DW1-live shows "Showing 1 to 10 of 106 entries" and carries no other
 * copy. Rows that fit in the pages before the last one, or fewer than the page declares, are a slice.
 */
export function readEncompassPage(html: string): EncompassPage {
  const table = parseTable(html);
  const embedded = parseEmbedded(html);
  const best = embedded.rows.length > table.rows.length ? embedded : table;
  const declared = Number(html.match(/Showing\s+[\d,]+\s+to\s+[\d,]+\s+of\s+([\d,]+)\s+entries/i)?.[1].replace(/,/g, ""));
  if (declared > best.entries) return { rows: best.rows, slice: `it declares ${declared} entries and carries ${best.entries}` };
  let pages = 1;
  for (const m of html.matchAll(/aria-label="Go to page (\d+)"|data-dt-idx="(\d+)"/g)) pages = Math.max(pages, m[1] ? Number(m[1]) : Number(m[2]) + 1);
  if (pages > 1 && best.entries <= (pages - 1) * table.entries) {
    return { rows: best.rows, slice: `it pages ${table.entries} rows at a time over ${pages} pages and carries ${best.entries}` };
  }
  return { rows: best.rows, slice: null };
}

export function parseEncompassPage(html: string): SupplierRow[] {
  return readEncompassPage(html).rows;
}

/** Highest "/_/N" page link on the page, capped. */
export function encompassPageCount(html: string, cap = 20): number {
  let max = 1;
  for (const m of html.matchAll(/\/_\/(\d{1,3})\b/g)) max = Math.max(max, Number(m[1]));
  return Math.min(max, cap);
}

/** The "/_/N" page an Encompass URL names: 1 for the model page itself, 0 for no URL. */
export function encompassPageNumber(url: string): number {
  try {
    return Number(new URL(url).pathname.match(/\/_\/(\d+)\/?$/)?.[1] ?? 1);
  } catch {
    return 0;
  }
}

export async function lookupEncompass(q: ModelQuery, fetcher: Fetcher): Promise<SupplierResult> {
  const started = Date.now();
  const visited: string[] = [];
  const warnings: string[] = [];
  const urls = encompassModelUrls(q.brand, q.model);
  const done = (status: SupplierResult["status"], rows: SupplierRow[] = [], sourceUrl: string | null = null): SupplierResult => ({
    supplier: "encompass", status, rows, droppedRows: 0, sourceUrl, visited, warnings, elapsedMs: Date.now() - started
  });
  if (!urls.length) {
    warnings.push(`No Encompass brand prefix for "${q.brand}".`);
    return done("not_found");
  }
  if (hasPlaceholder(q.model)) {
    warnings.push(`Model "${q.model}" has unread characters; read the nameplate before a lookup.`);
    return done("mismatch");
  }
  let sawError = false;
  let sawMismatch = false;
  for (const url of urls) {
    const first = await fetcher(url);
    visited.push(first.finalUrl);
    if (!first.ok) {
      sawError ||= first.status !== 404;
      warnings.push(`Encompass HTTP ${first.status} for ${url}`);
      continue;
    }
    if (isInvalidModelPage(first.html) || /Invalid-Model/i.test(first.finalUrl)) continue;
    if (encompassModelCode(first.finalUrl) !== encompassModelCode(url)) {
      sawMismatch = true;
      warnings.push(`Encompass redirected ${url} to ${first.finalUrl}, which is not ${q.brand} ${q.model}; nothing was read from it.`);
      continue;
    }
    const { rows, slice } = readEncompassPage(first.html);
    if (!rows.length) {
      warnings.push(`Encompass page had no parseable parts: ${url}`);
      continue;
    }
    // The URL is not enough: a page served at it without a redirect must name this model itself.
    const named = encompassPageIdentity(q, url, first.html);
    if (named.status !== "ok") {
      sawMismatch = true;
      warnings.push(named.status === "mismatch"
        ? `Encompass page ${url} names ${named.named}, which is not ${q.brand} ${q.model}; nothing was read from it.`
        : `Encompass page ${url} does not name its model; nothing was read from it.`);
      continue;
    }
    if (slice) {
      sawError = true;
      warnings.push(`Encompass page ${url} holds only the visible part of its parts list (${slice}); the catalog was rejected as incomplete.`);
      continue;
    }
    // Every listed page is required: a catalog missing any of them is never saved.
    const pages = encompassPageCount(first.html);
    const listed = encompassPageCount(first.html, Infinity);
    if (listed > pages) {
      sawError = true;
      warnings.push(`Encompass lists ${listed} pages for ${url}, more than the ${pages} read per lookup; the catalog was rejected as incomplete.`);
      continue;
    }
    let gap: "error" | "mismatch" | null = null;
    for (let page = 2; page <= pages && !gap; page += 1) {
      const next = await fetcher(`${url.replace(/\/$/, "")}/_/${page}`);
      visited.push(next.finalUrl);
      // A listed page that loads but cannot be shown to be this model's page N is a gap, never zero rows.
      let missing: string | null = null;
      if (!next.ok) {
        missing = `failed (HTTP ${next.status})`;
      } else if (isInvalidModelPage(next.html) || /Invalid-Model/i.test(next.finalUrl)) {
        missing = "answered that the model does not exist";
      } else if (encompassModelCode(next.finalUrl) !== encompassModelCode(url)) {
        gap = "mismatch";
        warnings.push(`Encompass page ${page} of ${url} redirected to ${next.finalUrl}, another model; the catalog was rejected and nothing was saved.`);
      } else if (encompassPageNumber(next.finalUrl) !== page) {
        missing = `landed on ${next.finalUrl}, not page ${page}`;
      } else {
        const read = readEncompassPage(next.html);
        const named = read.rows.length ? encompassPageIdentity(q, url, next.html) : null;
        if (!read.rows.length) missing = "had no parseable parts";
        else if (named?.status === "mismatch") {
          gap = "mismatch";
          warnings.push(`Encompass page ${page} of ${url} names ${named.named}, another model; the catalog was rejected and nothing was saved.`);
        } else if (named?.status === "unknown") missing = "does not name its model";
        else if (read.slice) missing = `holds only the visible part of its list (${read.slice})`;
        else rows.push(...read.rows);
      }
      if (missing) {
        gap = "error";
        warnings.push(`Encompass page ${page} of ${pages} ${missing} for ${url}; the catalog is incomplete and nothing was saved.`);
      }
    }
    if (gap === "mismatch") sawMismatch = true;
    if (gap === "error") sawError = true;
    if (gap) continue;
    return done("found", dedupe(rows), first.finalUrl);
  }
  return done(sawMismatch ? "mismatch" : sawError ? "error" : "not_found");
}

export function dedupe(rows: SupplierRow[]): SupplierRow[] {
  const byKey = new Map<string, SupplierRow>();
  for (const r of rows) {
    const prev = byKey.get(r.mpnCanonical);
    if (!prev) byKey.set(r.mpnCanonical, r);
    else if (!prev.diagramId && r.diagramId) byKey.set(r.mpnCanonical, { ...r, newPrice: prev.newPrice ?? r.newPrice });
  }
  return [...byKey.values()];
}
