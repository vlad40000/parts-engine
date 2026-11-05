import { load } from "cheerio";
import { canonicalizeMpn } from "@/src/lib/mpn";
import { lgVariation } from "@/src/lib/lg-variation";
import { priceNumber } from "./http";
import { dedupe } from "./encompass";
import type { Fetcher, ModelQuery, SupplierResult, SupplierRow } from "./types";

/**
 * LG manufacturer-variation BOM: the supplier's URL explicitly includes the
 * nameplate suffix. A generic /00 or base-model catalog is NOT evidence for the
 * ABWEVUS (or ABWETUS) variant. Read every linked diagram section or save none.
 *
 * Supplier: Home Depot Repair Parts (Eldis). No blind catalog-size assumptions
 * and no redirect to a different model/variation.
 */
export const LG_VARIATION_HOST = "https://www.appliancerepair.homedepot.com";

const modelBase = (model: string) => model.trim().toUpperCase();
export function lgVariationModelUrl(model: string, variation: string): string | null {
  const variant = lgVariation(variation);
  const base = modelBase(model);
  // A separate /00 or /01 revision must not be silently mapped to the base model.
  if (!variant || !/^[A-Z0-9-]+$/.test(base)) return null;
  return `${LG_VARIATION_HOST}/Models/${encodeURIComponent(base)}/MFGModelNumber/${variant}/`;
}

function identity(url: string, model: string, variation: string, section = false): boolean {
  try {
    const expected = lgVariationModelUrl(model, variation);
    if (!expected) return false;
    const u = new URL(url), target = new URL(expected);
    if (u.host !== target.host) return false;
    if (section ? !u.pathname.startsWith(target.pathname + "Sections/") : u.pathname.replace(/\/$/, "") !== target.pathname.replace(/\/$/, "")) return false;
    // Some section links additionally repeat the maker's code in their query.
    const code = u.searchParams.get("mfgModelNum");
    const namedModel = u.searchParams.get("ModelNum");
    return (!code || code.toUpperCase() === variation) && (!namedModel || namedModel.toUpperCase() === modelBase(model));
  } catch {
    return false;
  }
}

export function lgSectionLinks(html: string, modelUrl: string, model: string, variation: string): { links: string[]; foreign: number } {
  const $ = load(html), urls = new Set<string>();
  let foreign = 0;
  $('a[href*="/Sections/"]').each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    try {
      const absolute = new URL(href, modelUrl).toString();
      if (!identity(absolute, model, variation, true)) foreign += 1;
      else urls.add(absolute);
    } catch { foreign += 1; }
  });
  return { links: [...urls], foreign };
}

/** Deterministic parser for section entries labeled with both HD item ID and OEM part number. */
export function parseLgVariantSection(html: string, sectionName: string): { rows: SupplierRow[]; dropped: number } {
  const $ = load(html);
  const text = $("body").text().replace(/\u00a0/g, " ");
  const entries = [...text.matchAll(/Part\s*#:\s*(HD\d+)\s*Manufacturer\s+Part\s*#:\s*([A-Z0-9-]+)/gi)];
  const rows: SupplierRow[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const found = entries[i];
    const mpnDisplay = found[2].toUpperCase();
    const mpnCanonical = canonicalizeMpn(mpnDisplay);
    if (mpnCanonical.length < 3) continue;
    const start = (found.index ?? 0) + found[0].length;
    const end = entries[i + 1]?.index ?? text.length;
    const trailing = text.slice(start, end);
    const prefixStart = i === 0 ? 0 : (entries[i - 1].index ?? 0) + entries[i - 1][0].length;
    const prefix = text.slice(prefixStart, found.index);
    // The product title sits immediately before its "Part #:" line; if the supplier
    // changes markup, preserve an unambiguous generic description rather than guess.
    const desc = prefix.trim().split(/[\r\n]+/).filter(Boolean).at(-1)?.trim();
    const description = desc && desc.length <= 100 && !/Part #|Manufacturer Part #/i.test(desc)
      ? desc : "LG replacement part";
    const diagramId = trailing.match(/\b([AFK]\d{3})\b/i)?.[1]?.toUpperCase() ?? sectionName;
    const nla = /no longer available/i.test(trailing);
    rows.push({
      mpnDisplay, mpnCanonical, description, diagramId, supplierPartId: found[1].toUpperCase(),
      newPrice: nla ? null : priceNumber(trailing.match(/\$\s*[\d,.]+/)?.[0] ?? ""), nla
    });
  }
  // An unrecognized row is not an OEM. It cannot be silently mapped from an HD number.
  const listed = [...text.matchAll(/Part\s*#:\s*HD\d+/gi)].length;
  return { rows, dropped: Math.max(0, listed - entries.length) };
}

export async function lookupLgVariation(q: ModelQuery, fetcher: Fetcher): Promise<SupplierResult> {
  const started = Date.now();
  const visited: string[] = [], warnings: string[] = [];
  const done = (status: SupplierResult["status"], rows: SupplierRow[] = [], dropped = 0, sourceUrl: string | null = null): SupplierResult =>
    ({ supplier: "homedepot-lg-variation", status, rows, droppedRows: dropped, sourceUrl, visited, warnings, elapsedMs: Date.now() - started });
  const variation = lgVariation(q.variation);
  const modelUrl = variation ? lgVariationModelUrl(q.model, variation) : null;
  if (!variation || !modelUrl) {
    warnings.push(`LG ${q.model}: a confirmed manufacturer variation and exact base model are required; do not substitute /00 or a related model.`);
    return done("mismatch");
  }
  const landing = await fetcher(modelUrl);
  visited.push(landing.finalUrl);
  if (!landing.ok) {
    warnings.push(`LG variation catalog HTTP ${landing.status} for ${modelUrl}; unverified, not declared unavailable.`);
    return done("error");
  }
  if (!identity(landing.finalUrl, q.model, variation)) {
    warnings.push(`LG variation catalog redirected outside exact identity ${q.model} ${variation}: ${landing.finalUrl}.`);
    return done("mismatch");
  }
  const $ = load(landing.html);
  const heading = $("h1").first().text().replace(/\s+/g, " ").toUpperCase();
  // Do not accept a search page or a base-model page merely served at this URL.
  if (!heading.includes(modelBase(q.model)) || !heading.includes(`(${variation})`)) {
    warnings.push(`LG catalog did not explicitly name both ${q.model} and ${variation}; refused.`);
    return done("mismatch");
  }
  const sections = lgSectionLinks(landing.html, landing.finalUrl, q.model, variation);
  if (sections.foreign || !sections.links.length || sections.links.length > 30) {
    warnings.push(`LG catalog lists ${sections.links.length} accepted sections and ${sections.foreign} foreign links; expected 1–30 exact-variation sections.`);
    return done(sections.foreign ? "mismatch" : "error");
  }
  const rows: SupplierRow[] = [];
  let dropped = 0;
  for (const url of sections.links) {
    const response = await fetcher(url);
    visited.push(response.finalUrl);
    if (!response.ok || !identity(response.finalUrl, q.model, variation, true)) {
      warnings.push(`LG ${variation} section failed or changed identity: ${url} (HTTP ${response.status}). No partial list saved.`);
      return done("error");
    }
    const section = load(response.html);
    const text = section("body").text().toUpperCase();
    if (!text.includes(modelBase(q.model))) {
      warnings.push(`LG ${variation} section does not name model ${q.model}: ${url}. No partial list saved.`);
      return done("error");
    }
    const sectionName = new URL(url).pathname.split("/Sections/")[1].split("/")[0];
    const parsed = parseLgVariantSection(response.html, sectionName);
    if (!parsed.rows.length) {
      warnings.push(`LG ${variation} section has no readable OEM rows: ${url}. No partial list saved.`);
      return done("error");
    }
    rows.push(...parsed.rows);
    dropped += parsed.dropped;
  }
  return done("found", dedupe(rows), dropped, landing.finalUrl);
}
