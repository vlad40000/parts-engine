import { load } from "cheerio";
import { catalogRow, matchesBrand, matchesModel, money, readCatalogPages, supplierUrl, type CatalogPage } from "./html-catalog";
import type { Fetcher, ModelQuery, SupplierResult } from "./types";

export const PARTSDR_HOST = "https://partsdr.com";
export const partsDrSearchUrl = (model: string) => `${PARTSDR_HOST}/search?query=${encodeURIComponent(model.trim())}`;

export function matchesPartsDrModel(html: string, q: ModelQuery): boolean {
  const $ = load(html), heading = $("h1").first().text().replace(/\s+/g, " ").trim();
  const model = heading.match(/([A-Z0-9][A-Z0-9./-]*)$/i)?.[1];
  const prefix = heading.replace(/^(?:Replacement Parts & Repair Help for|Search Parts that fit)\s+/i, "");
  return !!model && matchesModel(model, q.model) && matchesBrand(prefix, q.brand);
}

export function parsePartsDrPage(html: string): CatalogPage {
  const $ = load(html), rows: CatalogPage["rows"] = [];
  // Unavailable OEM parts have an unlinked card. They still belong to the model BOM.
  const cards = $("h4").filter((_, h) => $(h).parent().find("div").filter((_, d) =>
    $(d).children().length === 0 && /^Part\s*#/.test($(d).text().trim())).length > 0).map((_, h) => $(h).parent()[0]);
  let dropped = 0;
  cards.each((_, el) => {
    const card = $(el), label = card.find("div").filter((_, e) => $(e).children().length === 0 && /^Part\s*#/.test($(e).text().trim())).first().text();
    const mpn = label.replace(/^Part\s*#\s*/, "").trim();
    const row = catalogRow(mpn, card.find("h4").first().text(), money($, el), card.text(), null);
    if (row) rows.push(row); else dropped++;
  });
  const body = $("body").text().replace(/\s+/g, " ");
  const total = body.match(/Parts for this appliance\s+([\d,]+)\s+parts/i)?.[1];
  return { rows, cards: cards.length, total: total ? Number(total.replace(/,/g, "")) : null, dropped };
}

export async function lookupPartsDr(q: ModelQuery, fetcher: Fetcher): Promise<SupplierResult> {
  const started = Date.now(), visited: string[] = [], warnings: string[] = [];
  const fail = (warning: string, status: "error" | "not_found" = "error"): SupplierResult => ({
    supplier: "partsdr", status, rows: [], droppedRows: 0, sourceUrl: null, visited, warnings: [...warnings, warning], elapsedMs: Date.now() - started
  });
  let model = await fetcher(partsDrSearchUrl(q.model)); visited.push(model.finalUrl);
  if (!model.ok) return fail(`Parts Dr search HTTP ${model.status}.`, model.status === 404 ? "not_found" : "error");
  if (!supplierUrl(model.finalUrl, PARTSDR_HOST)) return fail("Parts Dr search left its supplier domain.");
  if (!matchesPartsDrModel(model.html, q)) {
    const $ = load(model.html);
    const matches = new Set($("a[href]").toArray().flatMap((a) => {
      const url = supplierUrl($(a).attr("href") ?? "", PARTSDR_HOST);
      const label = $(a).text().replace(/\s+/g, " ").trim();
      const last = label.match(/([A-Z0-9][A-Z0-9./-]*)$/i)?.[1];
      return url && /^\/appliance-models\/[^/]+\/?$/.test(new URL(url).pathname) && last && matchesModel(last, q.model) && matchesBrand(label, q.brand) ? [url] : [];
    }));
    if (matches.size !== 1) return fail("Parts Dr did not identify one exact brand/model. Check the full model revision.");
    model = await fetcher([...matches][0]); visited.push(model.finalUrl);
  }
  if (!model.ok || !supplierUrl(model.finalUrl, PARTSDR_HOST) || !matchesPartsDrModel(model.html, q)) return fail("Parts Dr model page did not match the exact brand and model.");
  const $ = load(model.html), path = new URL(model.finalUrl).pathname.replace(/\/$/, "") + "/parts";
  const url = $("a[href]").toArray().map((a) => supplierUrl($(a).attr("href") ?? "", model.finalUrl)).find((u) => u && new URL(u).pathname === path);
  if (!url) return fail("Parts Dr full parts-list link was missing; popular parts were not imported.");
  const first = await fetcher(url); visited.push(first.finalUrl);
  return readCatalogPages({ supplier: "partsdr", q, first, url, fetcher, parse: parsePartsDrPage, matches: matchesPartsDrModel,
    pageParam: "page", started, visited, warnings });
}
