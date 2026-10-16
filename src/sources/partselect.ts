import { load } from "cheerio";
import { catalogRow, matchesBrand, matchesModel, money, readCatalogPages, supplierUrl, type CatalogPage } from "./html-catalog";
import type { Fetcher, ModelQuery, SupplierResult } from "./types";

export const PARTSELECT_HOST = "https://www.partselect.com";
export const partSelectModelUrl = (model: string) => `${PARTSELECT_HOST}/Models/${encodeURIComponent(model.trim().split("/")[0])}/`;

export function matchesPartSelectModel(html: string, q: ModelQuery): boolean {
  const $ = load(html), heading = $("h1").first().text().replace(/\s+/g, " ").trim();
  const m = heading.match(/^(\S+)\s+(?:\(([^)]+)\)\s+)?(.+?)\s+-\s+(?:Overview|Parts)$/i);
  return !!m && matchesModel(m[1] + (m[2] ? "/" + m[2] : ""), q.model) && matchesBrand(m[3], q.brand);
}

export function parsePartSelectPage(html: string): CatalogPage {
  const $ = load(html), rows: CatalogPage["rows"] = [];
  const cards = $(".mega-m__part"); let dropped = 0, excluded = 0;
  cards.each((_, el) => {
    const card = $(el), title = card.find(".mega-m__part__name").first();
    const label = card.find("div").filter((_, e) => $(e).children().length === 0 && /^Part\s*#/.test($(e).text().trim())).first().text();
    const id = title.attr("href")?.match(/\/(PS\d+)-/i)?.[1] ?? null;
    const mpn = label.replace(/^Part\s*#\s*/, "").trim();
    if (/^CALL[_ -]1-800-[A-Z]+$/i.test(mpn)) { excluded++; return; }
    const row = catalogRow(mpn, title.text(), money($, el), card.text(), id);
    if (row) rows.push(row); else dropped++;
  });
  const body = $("body").text().replace(/\s+/g, " ");
  const total = body.match(/\b[\d,]+\s*[-–]\s*[\d,]+\s*of\s*([\d,]+)/)?.[1];
  return { rows, cards: cards.length, total: total ? Number(total.replace(/,/g, "")) : null, dropped, excluded };
}

export async function lookupPartSelect(q: ModelQuery, fetcher: Fetcher): Promise<SupplierResult> {
  const started = Date.now(), visited: string[] = [], warnings: string[] = [];
  const fail = (warning: string, status: "error" | "not_found" = "error"): SupplierResult => ({
    supplier: "partselect", status, rows: [], droppedRows: 0, sourceUrl: null, visited, warnings: [...warnings, warning], elapsedMs: Date.now() - started
  });
  let model = await fetcher(partSelectModelUrl(q.model)); visited.push(model.finalUrl);
  if (!model.ok) return fail(`PartSelect model HTTP ${model.status}.`, model.status === 404 ? "not_found" : "error");
  if (!supplierUrl(model.finalUrl, PARTSELECT_HOST)) return fail("PartSelect model left its supplier domain.");
  let $ = load(model.html);
  const variants = new Set($("a[href]").toArray().flatMap((a) => {
    const url = supplierUrl($(a).attr("href") ?? "", PARTSELECT_HOST);
    return url && /\/MFGModelNumber\/[^/]+\/$/.test(new URL(url).pathname) ? [url] : [];
  }));
  if (variants.size && !/\/MFGModelNumber\//.test(new URL(model.finalUrl).pathname)) {
    const matches = [...variants].filter((u) => {
      const m = new URL(u).pathname.match(/\/Models\/([^/]+)\/MFGModelNumber\/([^/]+)\//);
      return m && matchesModel(decodeURIComponent(m[1]) + "/" + decodeURIComponent(m[2]), q.model);
    });
    if (matches.length !== 1) return fail("PartSelect lists several revisions. Provide the exact suffix; no revision was guessed.");
    model = await fetcher(matches[0]); visited.push(model.finalUrl); $ = load(model.html);
  }
  if (!model.ok || !supplierUrl(model.finalUrl, PARTSELECT_HOST) || !matchesPartSelectModel(model.html, q)) return fail("PartSelect model page did not match the exact brand and model.");
  const path = new URL(model.finalUrl).pathname.replace(/\/$/, "") + "/Parts/";
  const url = $("a[href]").toArray().map((a) => supplierUrl($(a).attr("href") ?? "", model.finalUrl)).find((u) => u && new URL(u).pathname === path);
  if (!url) return fail("PartSelect full parts-list link was missing; popular parts were not imported.");
  const first = await fetcher(url); visited.push(first.finalUrl);
  return readCatalogPages({ supplier: "partselect", q, first, url, fetcher, parse: parsePartSelectPage, matches: matchesPartSelectModel,
    pageParam: "start", started, visited, warnings });
}
