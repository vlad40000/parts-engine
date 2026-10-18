import { load } from "cheerio";
import { canonicalizeMpn } from "@/src/lib/mpn";
import { priceNumber } from "./http";
import { dedupe } from "./encompass";
import { appPageIdentity, appSectionBelongs, hasPlaceholder } from "./identity";
import type { Fetcher, ModelQuery, SupplierResult, SupplierRow } from "./types";

/**
 * AppliancePartsPros — model page lists section links; each section page lists parts.
 * Ported from Ledger src/sources/ladder-suppliers.ts (live evidence 2026-06-22). Changes:
 *   - every section is fetched (Ledger caps at 12)
 *   - OEM is read from the part link slug, including hyphenated Samsung numbers
 *   - rows with no OEM are dropped and counted, never stored under the AP id
 *   - the search is by model only and follows redirects, so the landing page and every
 *     section page must name this exact brand + model before anything is read
 *   - a catalog with any section blocked, missing, failed or for another model is rejected
 *     whole, never saved partially
 *   - a page that neither confirms the model nor lists sections is unresolved, never not found
 */
export const appSearchUrl = (model: string) =>
  `https://www.appliancepartspros.com/search.aspx?model=${encodeURIComponent(model.trim())}`;

const abs = (base: string, href: string) => {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
};

export function extractSectionLinks(html: string, baseUrl: string): string[] {
  const $ = load(html);
  const links = new Set<string>();
  $(".diagram-part-box a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (href) links.add(abs(baseUrl, href));
  });
  return [...links];
}

/**
 * Detail slugs end "...-{oem}-ap{digits}.html". Samsung-style OEMs contain a hyphen
 * (dc47-00019a, 6602-001655), so try that shape before the single-segment form.
 */
export function oemFromSlug(href: string, ap: string): string {
  const apToken = ap.toLowerCase();
  const tail = new RegExp(`-${apToken}\\.html(?:[?#]|$)`, "i");
  if (!tail.test(href)) return "";
  const path = href.replace(tail, "");
  const hyphenated = path.match(/-([a-z]{0,3}\d{2,4}-\d{5,6}[a-z]?)$/i);
  if (hyphenated) return hyphenated[1].toUpperCase();
  const single = path.match(/-([a-z0-9]+)$/i);
  if (!single) return "";
  const token = single[1];
  // A slug word ("panel", "top") is not a part number: require a digit.
  return /\d/.test(token) ? token.toUpperCase() : "";
}

export function parseSectionPage(html: string): { rows: SupplierRow[]; dropped: number } {
  const $ = load(html);
  const h1 = $("h1").first().text().trim();
  const colon = h1.indexOf(": ");
  const diagramId = (colon >= 0 ? h1.slice(colon + 2) : h1).replace(/\s*Parts\s*$/i, "").trim();

  const rows: SupplierRow[] = [];
  let dropped = 0;
  $('[class*="product-item-list-hold"]').each((_, el) => {
    const $el = $(el);
    const ap = (($el.attr("data-search") ?? "").trim().split(/\s+/)[0] ?? "").toUpperCase();
    if (!/^AP\d+$/.test(ap)) return;
    const link = $el.find(".product-item-heading h3 a").first();
    const description = link.text().trim();
    const oem = oemFromSlug(link.attr("href") ?? "", ap);
    if (!oem) {
      dropped += 1;
      return;
    }
    rows.push({
      mpnDisplay: oem,
      mpnCanonical: canonicalizeMpn(oem),
      description,
      diagramId,
      supplierPartId: ap,
      newPrice: priceNumber($el.find("strong.price").first().text()),
      nla: /no longer available|discontinued/i.test($el.text())
    });
  });
  return { rows, dropped };
}

export async function lookupAppliancePartsPros(
  q: ModelQuery,
  fetcher: Fetcher,
  opts: { maxSections?: number } = {}
): Promise<SupplierResult> {
  const started = Date.now();
  const visited: string[] = [];
  const warnings: string[] = [];
  const done = (status: SupplierResult["status"], rows: SupplierRow[] = [], dropped = 0, sourceUrl: string | null = null): SupplierResult => ({
    supplier: "appliancepartspros", status, rows, droppedRows: dropped, sourceUrl, visited, warnings, elapsedMs: Date.now() - started
  });

  if (hasPlaceholder(q.model)) {
    warnings.push(`Model "${q.model}" has unread characters; read the nameplate before a lookup.`);
    return done("mismatch");
  }
  const model = await fetcher(appSearchUrl(q.model));
  visited.push(model.finalUrl);
  if (!model.ok) {
    warnings.push(`AppliancePartsPros HTTP ${model.status}`);
    return done(model.status === 404 ? "not_found" : "error");
  }
  const identity = appPageIdentity(q, model.finalUrl, model.html);
  if (identity.status === "mismatch") {
    warnings.push(`AppliancePartsPros returned ${identity.page}, which is not ${q.brand} ${q.model}; nothing was read from it.`);
    return done("mismatch");
  }
  const links = extractSectionLinks(model.html, model.finalUrl);
  if (identity.status === "unknown") {
    if (!links.length) {
      // A no-results page, a list of other models and a changed layout look alike here (838 production
      // searches, audit 2026-10-17), so none of them is evidence that the supplier lacks this model.
      warnings.push(`AppliancePartsPros answered with ${model.finalUrl}, which neither confirms ${q.brand} ${q.model} nor lists parts sections; `
        + "an unidentifiable page is not evidence the model is missing, so it was not recorded as not found.");
      return done("error");
    }
    warnings.push(`AppliancePartsPros page ${model.finalUrl} does not name its model; nothing was read from it.`);
    return done("mismatch");
  }
  if (!links.length) {
    // Not found only when the supplier says so: HTTP 404 above, or this model's own confirmed page listing no sections.
    warnings.push(`AppliancePartsPros lists ${q.brand} ${q.model} at ${model.finalUrl} but no parts sections; recorded as not found.`);
    return done("not_found");
  }
  // Every section the model page lists is required: a parts list missing any of them is never saved.
  const foreign = links.filter((url) => !appSectionBelongs(url, identity.slugs));
  if (foreign.length) {
    warnings.push(`${foreign.length} of ${links.length} section links are for another model (${foreign[0]}); the catalog was rejected and nothing was read.`);
    return done("mismatch");
  }
  const max = opts.maxSections ?? 40;
  if (links.length > max) {
    warnings.push(`The catalog lists ${links.length} sections, more than the ${max} read per lookup; it was rejected as incomplete and nothing was read.`);
    return done("error");
  }

  const results = await Promise.all(
    links.map(async (url) => {
      const page = await fetcher(url);
      visited.push(page.finalUrl);
      if (!page.ok) {
        warnings.push(`Section ${sectionGap(page.status)} (HTTP ${page.status}): ${url}`);
        return { gap: "unread" as const, rows: [], dropped: 0 };
      }
      if (!appSectionBelongs(page.finalUrl, identity.slugs)) {
        warnings.push(`Section ${url} redirected to ${page.finalUrl}, another model.`);
        return { gap: "mismatched" as const, rows: [], dropped: 0 };
      }
      return { gap: null, ...parseSectionPage(page.html) };
    })
  );
  const gaps = results.filter((r) => r.gap);
  if (gaps.length) {
    warnings.push(`${gaps.length} of ${links.length} sections could not be read for this model, so the catalog is incomplete; nothing was saved.`);
    return done(gaps.some((r) => r.gap === "mismatched") ? "mismatch" : "error");
  }
  const rows = dedupe(results.flatMap((r) => r.rows));
  const dropped = results.reduce((n, r) => n + r.dropped, 0);
  if (dropped) warnings.push(`${dropped} listed parts had no readable OEM number and were left out.`);
  return done(rows.length ? "found" : "not_found", rows, dropped, model.finalUrl);
}

/**
 * Why a section page was not read. A section that loads but lists no parts (a cover sheet, a
 * wiring page) is read and empty, not missing: the audit found such sections in about 580
 * verified production BOMs.
 */
function sectionGap(status: number): "blocked" | "missing" | "failed" {
  if (status === 401 || status === 403 || status === 429) return "blocked";
  if (status === 404 || status === 410) return "missing";
  return "failed";
}
