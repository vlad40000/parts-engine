import { load } from "cheerio";
import { canonicalizeMpn, displayMpn } from "@/src/lib/mpn";
import { priceNumber } from "./http";
import type { Fetcher, ModelQuery, SupplierResult, SupplierRow } from "./types";

/**
 * Encompass PartStore — whole model BOM on one page, OEM part numbers direct.
 * Ported from Ledger src/sources/encompass.ts + encompass-parser.ts (deterministic
 * HTML path that Ledger has but never wires up). Changes:
 *   - pagination reads real "/_/N" links instead of any number on the page
 *   - slash models (Samsung/LG "DV45H7000EW/A2") try Encompass's "|" form
 *   - invalid-model page detected
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
  const prefixes = [abv, ...(FALLBACK_ABV[abv] ?? [])];
  const urls: string[] = [];
  const [base, suffix] = model.trim().split("/");
  for (const p of prefixes) {
    if (suffix !== undefined && strip(suffix)) {
      // Verified 2026-10-06: /model/SMGDV45H7000EW%7CA2/0001/ lists the Samsung BOM.
      urls.push(`${ENCOMPASS_HOST}/model/${p}${strip(base)}%7C${strip(suffix)}`);
      urls.push(`${ENCOMPASS_HOST}/model/${p}${strip(base)}%7C${strip(suffix)}/0001/`);
    }
    urls.push(`${ENCOMPASS_HOST}/model/${p}${strip(model)}`);
  }
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

function parseEmbedded(html: string): SupplierRow[] {
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
      return parts.flatMap((p) => {
        const row = toRow(p.partNumber ?? "", p.partDescription ?? "", p.location ?? "", p.reportPartPrice ?? p.partPrice ?? "", p.allowPurchase === "N");
        return row ? [row] : [];
      });
    } catch {
      /* try next payload */
    }
  }
  return [];
}

function parseTable(html: string): SupplierRow[] {
  const $ = load(html);
  const table = $("table").filter((_, el) => /Part Number/i.test($(el).text())).first();
  if (!table.length) return [];
  const headers = new Map<string, number>();
  table.find("tr").first().find("th,td").each((i, cell) => {
    const name = $(cell).text().replace(/\s+/g, " ").trim().toLowerCase();
    if (name) headers.set(name, i);
  });
  const pn = headers.get("part number");
  const title = headers.get("part title") ?? headers.get("description");
  const price = headers.get("price");
  const avail = headers.get("availability");
  if (pn === undefined || title === undefined) return [];

  const rows: SupplierRow[] = [];
  table.find("tr").slice(1).each((_, tr) => {
    const cells = $(tr).find("td,th").toArray();
    if (cells.length <= Math.max(pn, title)) return;
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
  return rows;
}

export function parseEncompassPage(html: string): SupplierRow[] {
  const table = parseTable(html);
  const embedded = parseEmbedded(html);
  return embedded.length > table.length ? embedded : table;
}

/** Highest "/_/N" page link on the page, capped. */
export function encompassPageCount(html: string, cap = 20): number {
  let max = 1;
  for (const m of html.matchAll(/\/_\/(\d{1,3})\b/g)) max = Math.max(max, Number(m[1]));
  return Math.min(max, cap);
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
  let sawError = false;
  for (const url of urls) {
    const first = await fetcher(url);
    visited.push(first.finalUrl);
    if (!first.ok) {
      sawError ||= first.status !== 404;
      warnings.push(`Encompass HTTP ${first.status} for ${url}`);
      continue;
    }
    if (isInvalidModelPage(first.html) || /Invalid-Model/i.test(first.finalUrl)) continue;
    const rows = parseEncompassPage(first.html);
    if (!rows.length) {
      warnings.push(`Encompass page had no parseable parts: ${url}`);
      continue;
    }
    const pages = encompassPageCount(first.html);
    for (let page = 2; page <= pages; page += 1) {
      const next = await fetcher(`${url.replace(/\/$/, "")}/_/${page}`);
      visited.push(next.finalUrl);
      if (!next.ok) {
        warnings.push(`Encompass page ${page} failed (HTTP ${next.status}); later pages skipped.`);
        break;
      }
      rows.push(...parseEncompassPage(next.html));
    }
    return done("found", dedupe(rows), first.finalUrl);
  }
  return done(sawError ? "error" : "not_found");
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
