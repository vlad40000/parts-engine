import { createHash } from "node:crypto";
import { load, type CheerioAPI } from "cheerio";
import { modelKey } from "@/src/lib/model-key";
import { canonicalizeMpn, displayMpn } from "@/src/lib/mpn";
import { priceNumber } from "./http";
import { dedupe } from "./encompass";
import type { Fetcher, FetchResult, ModelQuery, SupplierResult, SupplierRow } from "./types";

export function supplierUrl(href: string, base: string): string | null {
  try {
    const u = new URL(href, base), b = new URL(base);
    if (u.protocol !== "https:" || u.hostname !== b.hostname || u.port || u.username || u.password) return null;
    u.hash = "";
    return u.toString();
  } catch { return null; }
}

const words = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
export function matchesBrand(text: string, brand: string): boolean {
  const aliases = words(brand) === "GE" ? ["GE", "GENERAL ELECTRIC"] : [brand];
  const tokens = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
  return aliases.some((b) => tokens(text) === tokens(b) || tokens(text).startsWith(tokens(b) + " "));
}
export const matchesModel = (actual: string, requested: string) => modelKey(actual) === modelKey(requested);

export function catalogRow(mpn: string, description: string, price: string, text: string, id: string | null): SupplierRow | null {
  const display = displayMpn(mpn);
  if (!/^[A-Z0-9][A-Z0-9.-]*$/i.test(display) || canonicalizeMpn(display).length < 3 || !/\d/.test(display) || /^(?:PS|PD|AP)\d+$/i.test(display)) return null;
  const nla = /no longer available|discontinued|\bnla\b/i.test(text);
  return { mpnDisplay: display, mpnCanonical: canonicalizeMpn(display), description: description.replace(/\s+/g, " ").trim(),
    diagramId: "", supplierPartId: id, newPrice: nla ? null : priceNumber(price), nla };
}

export type CatalogPage = { rows: SupplierRow[]; cards: number; total: number | null; dropped: number; excluded?: number };
export function money($: CheerioAPI, selector: Parameters<CheerioAPI>[0]): string {
  return $(selector).find("*").filter((_, e) => $(e).children().length === 0 && /^\$\s*[\d,]+\.\d{2}$/.test($(e).text().trim())).first().text().trim();
}

/** All advertised pages must reconcile. Partial/changed/repeated pages never become a verified BOM. */
export async function readCatalogPages(args: {
  supplier: string; q: ModelQuery; first: FetchResult; url: string; fetcher: Fetcher;
  parse: (html: string) => CatalogPage; matches: (html: string, q: ModelQuery) => boolean;
  pageParam: "page" | "start"; started: number; visited: string[]; warnings: string[];
}): Promise<SupplierResult> {
  const { supplier, q, first, url, fetcher, parse, matches, pageParam, started, visited, warnings } = args;
  const done = (status: SupplierResult["status"], rows: SupplierRow[] = [], pages = 0, total = 0): SupplierResult => ({
    supplier, status, rows, sourceUrl: url, droppedRows: excluded, visited, warnings, elapsedMs: Date.now() - started,
    completeness: status === "found" ? "complete" : "unknown", catalogPages: pages, catalogRows: total
  });
  const fail = (reason: string) => { warnings.push(reason); return done("error"); };
  const pending = new Map<number, string>([[1, url]]), seen = new Set<number>(), signatures = new Set<string>();
  const rows: SupplierRow[] = [];
  let total: number | null = null, cards = 0, excluded = 0;
  while (pending.size) {
    const pageNo = Math.min(...pending.keys()), pageUrl = pending.get(pageNo)!;
    pending.delete(pageNo);
    if (seen.has(pageNo)) continue;
    if (seen.size >= 50 || Date.now() - started > 110_000) return fail("Catalog limit reached; incomplete parts list was not saved.");
    const response = pageNo === 1 ? first : await fetcher(pageUrl);
    if (pageNo !== 1) visited.push(response.finalUrl);
    const final = supplierUrl(response.finalUrl, url);
    if (!response.ok || !final || new URL(final).pathname !== new URL(url).pathname) return fail(`Catalog page ${pageNo} failed or redirected (HTTP ${response.status}).`);
    if (!matches(response.html, q)) return fail(`Catalog page ${pageNo} did not match the exact brand and model.`);
    const parsed = parse(response.html);
    if (parsed.total == null || parsed.total > 5000 || parsed.total < 0) return fail("Catalog total was missing or exceeded the supported limit.");
    total ??= parsed.total;
    if (parsed.total !== total || parsed.dropped || parsed.rows.length + (parsed.excluded ?? 0) !== parsed.cards) return fail("Catalog rows or OEM numbers did not reconcile; incomplete parts list was not saved.");
    const signature = createHash("sha256").update(JSON.stringify(parsed.rows)).digest("hex");
    if (signatures.has(signature)) return fail("Catalog repeated a page; incomplete parts list was not saved.");
    signatures.add(signature); seen.add(pageNo); cards += parsed.cards; excluded += parsed.excluded ?? 0; rows.push(...parsed.rows);
    const $ = load(response.html);
    for (const a of $("a[href]").toArray()) {
      const next = supplierUrl($(a).attr("href") ?? "", pageUrl);
      if (!next || new URL(next).pathname !== new URL(url).pathname) continue;
      const n = new URL(next).searchParams.get(pageParam);
      if (!n || !/^\d+$/.test(n)) continue;
      const index = Number(n);
      if (index < 1 || index > 50) return fail("Catalog pagination exceeded the supported limit.");
      if (!seen.has(index)) {
        const canonical = new URL(url); canonical.search = ""; canonical.searchParams.set(pageParam, String(index));
        pending.set(index, canonical.toString());
      }
    }
  }
  if (cards !== total) return fail(`Catalog advertised ${total} rows but returned ${cards}; incomplete parts list was not saved.`);
  if (excluded) warnings.push(`${excluded} supplier contact placeholders were excluded; they are not OEM part numbers.`);
  return done(rows.length ? "found" : "not_found", dedupe(rows), seen.size, cards);
}
