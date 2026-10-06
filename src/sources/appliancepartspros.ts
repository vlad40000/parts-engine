import { load } from "cheerio";
import { canonicalizeMpn } from "@/src/lib/mpn";
import { priceNumber } from "./http";
import { dedupe } from "./encompass";
import type { Fetcher, ModelQuery, SupplierResult, SupplierRow } from "./types";

/**
 * AppliancePartsPros — model page lists section links; each section page lists parts.
 * Ported from Ledger src/sources/ladder-suppliers.ts (live evidence 2026-06-22). Changes:
 *   - every section is fetched (Ledger caps at 12)
 *   - OEM is read from the part link slug, including hyphenated Samsung numbers
 *   - rows with no OEM are dropped and counted, never stored under the AP id
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

  const model = await fetcher(appSearchUrl(q.model));
  visited.push(model.finalUrl);
  if (!model.ok) {
    warnings.push(`AppliancePartsPros HTTP ${model.status}`);
    return done(model.status === 404 ? "not_found" : "error");
  }
  const sections = extractSectionLinks(model.html, model.finalUrl);
  if (!sections.length) {
    warnings.push("AppliancePartsPros model page had no section links (model not found or page changed).");
    return done("not_found");
  }
  const max = opts.maxSections ?? 40;
  if (sections.length > max) warnings.push(`Only the first ${max} of ${sections.length} sections were read.`);

  const results = await Promise.all(
    sections.slice(0, max).map(async (url) => {
      const page = await fetcher(url);
      visited.push(page.finalUrl);
      if (!page.ok) {
        warnings.push(`Section HTTP ${page.status}: ${url}`);
        return { rows: [], dropped: 0 };
      }
      return parseSectionPage(page.html);
    })
  );
  const rows = dedupe(results.flatMap((r) => r.rows));
  const dropped = results.reduce((n, r) => n + r.dropped, 0);
  if (dropped) warnings.push(`${dropped} listed parts had no readable OEM number and were left out.`);
  return done(rows.length ? "found" : "not_found", rows, dropped, model.finalUrl);
}
