import { readFile } from "node:fs/promises";
import path from "node:path";
import { load } from "cheerio";
import { isInvalidModelPage } from "@/src/sources/encompass";
import { acquireAppDiagrams } from "@/src/sources/diagrams/appliancepartspros";
import { appDiagramIndex, parseAppDiagramSection } from "@/src/sources/diagrams/appliancepartspros";
import { acquireEncompassDiagrams, encompassExplodedLink, parseEncompassExplodedView } from "@/src/sources/diagrams/encompass";
import { acquireHdVariationDiagrams, hdOverviewIdentity, hdSectionIndex, hdVariationUrl, parseHdSection, type HdIdentity } from "@/src/sources/diagrams/homedepot-variation";
import { encompassPageIdentity } from "@/src/sources/identity";
import { oemPartsListAttempt, parseOemPartsListText } from "@/src/sources/diagrams/oem-parts-list";
import { isChallengePage, unreadable } from "@/src/sources/diagrams/outcome";
import { reconcileCallouts, sectionKey, type CalloutReconciliation } from "@/src/sources/diagrams/reconcile";
import type { DiagramAttempt, DiagramProvider, FetchRecord } from "@/src/sources/diagrams/types";
import { canonicalizeMpn } from "@/src/lib/mpn";
import type { Fetcher, FetchResult } from "@/src/sources/types";

/**
 * Shared by the offline fixture tests and the local network probe. A case is one fleet identity; each provider
 * tried for it is one attempt. Fixtures are minimized captures: only the elements the parsers read survive, and
 * the probe proves that by replaying them to the same evidence before writing them.
 */
export const FIXTURE_ROOT = path.resolve(__dirname, "fixtures", "diagrams");

export type DiagramCase = {
  id: string;
  role: "primary" | "historical" | "historical-alternate" | "variation";
  machine: string | null;
  fleetStatus: string | null;
  brand: string;
  model: string;
  variation: string | null;
  providers: Array<Exclude<DiagramProvider, "oem-parts-list">>;
  oemPartsList?: string;
  contrastVariation?: string;
};

export const DIAGRAM_CASES: DiagramCase[] = [
  {
    id: "maytag-mvw6230hw1", role: "primary", machine: "6613", fleetStatus: "PARTS ONLY", brand: "Maytag", model: "MVW6230HW1", variation: null,
    providers: ["appliancepartspros", "encompass"],
    oemPartsList: "https://assets.ajmadison.com/ajmadison/itemdocs/repair-parts-list-w11497934-revb.pdf"
  },
  { id: "ge-gss25wgtabb", role: "historical", machine: "2121", fleetStatus: "SOLD", brand: "GE", model: "GSS25WGTABB", variation: null, providers: ["appliancepartspros", "encompass"] },
  { id: "kenmore-790-91319013", role: "historical-alternate", machine: "4435", fleetStatus: "SCRAPPED", brand: "Kenmore", model: "790.91319013", variation: null, providers: ["appliancepartspros", "encompass"] },
  {
    id: "lg-wt7200cw-abwevus", role: "variation", machine: null, fleetStatus: null, brand: "LG", model: "WT7200CW", variation: "ABWEVUS",
    providers: ["homedepot", "appliancepartspros", "encompass"], contrastVariation: "ABWETUS"
  }
];

// ---------------------------------------------------------------------------------------------------------------
// Fixture minimization
// ---------------------------------------------------------------------------------------------------------------
const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const squash = (v: string) => v.replace(/\s+/g, " ").trim();

/** Keep only what the diagram parsers and identity checks read; drop scripts, styles, tracking, prices and forms. */
export function minimizeDiagramPage(html: string): string {
  if (isChallengePage(html)) {
    return "<!doctype html><html><head><title>Just a moment...</title></head><body>Enable JavaScript and cookies to continue</body></html>\n";
  }
  const $ = load(html);
  const head: string[] = [];
  const body: string[] = [];
  const canonical = $('link[rel="canonical"]').attr("href");
  if (canonical !== undefined) head.push(`<link rel="canonical" href="${esc(canonical)}">`);
  const h1 = $("h1").first();
  if (h1.length) body.push(`<h1>${esc(squash(h1.text()))}</h1>`);
  if (isInvalidModelPage(html)) body.push("<p>Model is not valid for this site (Invalid-Model)</p>");
  for (const m of new Set([...html.matchAll(/\\?"modelNumber\\?"\s*:\s*\\?"([^"\\]*)/g)].map((x) => x[1]))) {
    body.push(`<script type="application/json">{"modelNumber":"${esc(m)}"}</script>`);
  }
  // AppliancePartsPros model page: one box per assembly.
  $(".diagram-part-box a[href]").each((_, el) => {
    body.push(`<div class="diagram-part-box"><a href="${esc($(el).attr("href") ?? "")}"><strong class="title">${esc(squash($(el).find(".title").text()))}</strong></a></div>`);
  });
  // AppliancePartsPros section page: drawing and part rows.
  const full = $('img[id$="iDiagramFull"]').first();
  if (full.length) body.push(`<img id="${esc(full.attr("id") ?? "")}" src="${esc(full.attr("src") ?? "")}">`);
  $(".product-item-list-hold").each((_, el) => {
    const $el = $(el);
    const link = $el.find(".product-item-heading h3 a").first();
    body.push(`<div class="product-item-list-hold" data-search="${esc(($el.attr("data-search") ?? "").trim().split(/\s+/)[0] ?? "")}">`
      + `<div class="product-item-num">${esc(squash($el.find(".product-item-num").first().text()))}</div>`
      + `<div class="product-item-heading"><h3><a href="${esc(link.attr("href") ?? "")}">${esc(squash(link.text()))}</a></h3></div></div>`);
  });
  // Home Depot: assembly links, the full drawing (thumbnails keep their URL in data-src) and part rows.
  $('a[href*="/Sections/"]').each((_, el) => {
    body.push(`<a href="${esc($(el).attr("href") ?? "")}">${esc(squash($(el).text()))}</a>`);
  });
  $('img[src*="/Schematics/"]').each((_, el) => {
    body.push(`<img src="${esc($(el).attr("src") ?? "")}">`);
  });
  $(".js-mega-m-part").each((_, el) => {
    const $el = $(el);
    const labelled = (label: RegExp) => $el.find("div").filter((_, d) => label.test($(d).clone().children().remove().end().text().trim()))
      .first().find("span").first().text().trim();
    body.push(`<div class="js-mega-m-part"><a class="mega-m__part__name">${esc(squash($el.find(".mega-m__part__name").first().text()))}</a>`
      + `<div>Part #: <span>${esc(labelled(/^Part #:$/i))}</span></div>`
      + `<div>Manufacturer Part #: <span>${esc(labelled(/^Manufacturer Part #:$/i))}</span></div>`
      + `<span class="order-num">${esc(squash($el.find(".order-num").first().text()))}</span></div>`);
  });
  // Encompass: exploded-view links and assemblies.
  $('a[href*="/Exploded-View-Assembly/"]').each((_, el) => {
    body.push(`<a href="${esc($(el).attr("href") ?? "")}">Exploded View</a>`);
  });
  const thumbs = $(".exploded-views-thumbnails a[data-hp-assembly]").toArray().map((el) => {
    const $a = $(el);
    const attrs = ["data-hp-assembly", "data-hp-parentid", "data-hp-oem", "data-hp-name"].map((a) => `${a}="${esc($a.attr(a) ?? "")}"`).join(" ");
    return `<a ${attrs}><img src="${esc($a.find("img").attr("src") ?? "")}"><span class="thumb-name">${esc(squash($a.find(".thumb-name").text()))}</span></a>`;
  });
  if (thumbs.length) body.push(`<div class="exploded-views-thumbnails">${thumbs.join("")}</div>`);
  return `<!doctype html>\n<html><head>${head.join("")}</head><body>\n${body.join("\n")}\n</body></html>\n`;
}

/** A page captured by hand, kept as a source-only fixture with where and how it was fetched. */
export type SourceOnlyCapture = {
  fixture: string; brand: string; model: string; variation: string | null;
  requested: string; finalUrl: string; status: number; capturedAt: string; method: string;
  rawBytes?: number; rawSha256?: string;
};

/** Everything any diagram parser or identity check reads from one page, for proving a minimized copy equivalent. */
export function readEveryWay(entry: SourceOnlyCapture, html: string) {
  const q = { brand: entry.brand, model: entry.model, variation: entry.variation };
  const other = { ...q, variation: q.variation === "ABWEVUS" ? "ABWETUS" : "ABWEVUS" };
  return {
    hdOverview: [hdOverviewIdentity(q, entry.finalUrl, html), hdOverviewIdentity(other, entry.finalUrl, html)],
    hdIndex: hdSectionIndex(q, html, entry.finalUrl),
    hdSection: parseHdSection(html, entry.finalUrl),
    appIndex: appDiagramIndex(html, entry.finalUrl),
    appSection: parseAppDiagramSection(html, entry.finalUrl),
    encompassModel: encompassPageIdentity(q, entry.finalUrl, html),
    encompassLink: encompassExplodedLink(q, html, entry.finalUrl),
    encompassView: parseEncompassExplodedView(html)
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Capture manifest and replay
// ---------------------------------------------------------------------------------------------------------------
export type ManifestFetch = { requested: string; status: number; finalUrl: string; fixture: string | null; rawBytes: number; rawSha256: string };
export type ManifestOem = { url: string; status: number; finalUrl: string; bytes: number; sha256: string; extractor: string; fixture: string };
export type CaseManifest = { case: string; capturedAt: string; method: string; fetches: ManifestFetch[]; oemPartsList?: ManifestOem };

/** Serves each recorded response in the order it was captured. An uncaptured URL is an error, never a network call. */
export function replayFetcher(fetches: Array<{ requested: string; status: number; finalUrl: string; html: string }>): Fetcher {
  const queues = new Map<string, typeof fetches>();
  for (const f of fetches) queues.set(f.requested, [...(queues.get(f.requested) ?? []), f]);
  return async (url: string): Promise<FetchResult> => {
    const queue = queues.get(url);
    if (!queue?.length) throw new Error(`No captured response for ${url}`);
    const next = queue.length > 1 ? queue.shift()! : queue[0];
    return { ok: next.status >= 200 && next.status < 300, status: next.status, finalUrl: next.finalUrl, html: next.html };
  };
}

export async function loadCase(c: DiagramCase) {
  const dir = path.join(FIXTURE_ROOT, c.id);
  const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8")) as CaseManifest;
  const fetches = await Promise.all(manifest.fetches.map(async (f) => ({
    ...f, html: f.fixture ? await readFile(path.join(dir, f.fixture), "utf8") : ""
  })));
  const oem = manifest.oemPartsList
    ? { ...manifest.oemPartsList, text: await readFile(path.join(dir, manifest.oemPartsList.fixture), "utf8") }
    : undefined;
  return { manifest, fetcher: replayFetcher(fetches), oem };
}

// ---------------------------------------------------------------------------------------------------------------
// One case, all providers
// ---------------------------------------------------------------------------------------------------------------
export type OemCapture = { url: string; status: number; finalUrl: string; sha256: string; bytes: number; extractor: string; text: string };

export type ContrastCheck = {
  url: string; status: number; finalUrl: string;
  /** Why the page could not be checked (access refused, missing); identity is then not evaluated. */
  unread: string | null;
  /** The page checked against the intended variation: must be refused. */
  asIntended: HdIdentity | null;
  /** The same page checked against the variation it names: shows the refusal is about variation, not a broken page. */
  asContrast: HdIdentity | null;
};

export type CaseResult = {
  case: DiagramCase;
  capturedAt: string;
  attempts: DiagramAttempt[];
  contrast: ContrastCheck | null;
  reconciliation: CalloutReconciliation | null;
};

export async function runDiagramCase(c: DiagramCase, fetcher: Fetcher, capturedAt: Date, oem?: OemCapture): Promise<CaseResult> {
  const q = { brand: c.brand, model: c.model, variation: c.variation };
  const now = () => capturedAt;
  const attempts: DiagramAttempt[] = [];
  for (const provider of c.providers) {
    if (provider === "appliancepartspros") attempts.push(await acquireAppDiagrams(q, fetcher, { now }));
    if (provider === "encompass") attempts.push(await acquireEncompassDiagrams(q, fetcher, { now }));
    if (provider === "homedepot") attempts.push(await acquireHdVariationDiagrams(q, fetcher, { now }));
  }
  if (oem) {
    const fetch: FetchRecord = { url: oem.url, status: oem.status, finalUrl: oem.finalUrl, outcome: oem.status === 200 ? "read" : "failed",
      note: `PDF ${oem.bytes} bytes, sha256 ${oem.sha256}; text by ${oem.extractor}` };
    attempts.push(oemPartsListAttempt(q, parseOemPartsListText(oem.text), { pdfUrl: oem.finalUrl, retrievedAt: capturedAt.toISOString(), fetches: [fetch] }));
  }
  let contrast: ContrastCheck | null = null;
  if (c.contrastVariation) {
    const url = hdVariationUrl(c.model, c.contrastVariation);
    const res = await fetcher(url);
    const bad = unreadable(res);
    contrast = {
      url, status: res.status, finalUrl: res.finalUrl, unread: bad?.note ?? null,
      asIntended: bad ? null : hdOverviewIdentity(q, res.finalUrl, res.html),
      asContrast: bad ? null : hdOverviewIdentity({ ...q, variation: c.contrastVariation }, res.finalUrl, res.html)
    };
  }
  const catalog = attempts.find((a) => a.provider === "oem-parts-list" && a.outcome !== "blocked");
  const supplier = attempts.find((a) => a.provider === "appliancepartspros" && a.outcome !== "blocked");
  return {
    case: c, capturedAt: capturedAt.toISOString(), attempts, contrast,
    reconciliation: catalog && supplier ? reconcileCallouts(catalog, supplier) : null
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Results: one matrix row per attempted model and source, plus the machine 6613 callout evidence
// ---------------------------------------------------------------------------------------------------------------
export type MatrixRow = {
  case: string; role: DiagramCase["role"]; machine: string | null; fleetStatus: string | null;
  brand: string; model: string; variation: string | null; provider: DiagramProvider; sourceUrl: string | null; retrievedAt: string;
  expectedSections: number | null; retrievedSections: number; expectedRows: number | null; retrievedRows: number;
  /** Listed rows whose OEM number could not be read (kept with their callout, never guessed). */
  unreadRows: number;
  outcome: DiagramAttempt["outcome"]; reason: string;
};

export function matrixRows(results: CaseResult[]): MatrixRow[] {
  return results.flatMap(({ case: c, attempts }) => attempts.map((a) => ({
    case: c.id, role: c.role, machine: c.machine, fleetStatus: c.fleetStatus,
    brand: a.brand, model: a.model, variation: a.variation, provider: a.provider, sourceUrl: a.sourceUrl, retrievedAt: a.retrievedAt,
    expectedSections: a.expectedSections, retrievedSections: a.retrievedSections, expectedRows: a.expectedRows, retrievedRows: a.retrievedRows,
    unreadRows: a.sections.reduce((n, s) => n + s.unreadRows.length, 0),
    outcome: a.outcome, reason: a.reason
  })));
}

export type CalloutNumber = { mpn: string; mpnKey: string; role: "catalog" | "supplier_listed" | "observed" | "replacement"; evidence: string; source: string | null };

/**
 * Every number known for machine 6613's top-and-cabinet callout 10, each with its own role and evidence. The catalog
 * and supplier numbers are read from the fixtures; the observed board and the service replacement come from the
 * 6613 evidence notes cited in the 2026-11-23 handoff and are not fetched or re-verified by this probe.
 */
export function machine6613Callout10(maytag: CaseResult): { section: string; callout: string; numbers: CalloutNumber[] } {
  const at = (provider: DiagramProvider) => {
    const attempt = maytag.attempts.find((a) => a.provider === provider);
    const section = attempt?.sections.find((s) => sectionKey(s.assembly) === "TOPANDCABINET");
    return { section, rows: section?.callouts.filter((r) => r.callout === "10") ?? [] };
  };
  const catalog = at("oem-parts-list");
  const supplier = at("appliancepartspros");
  const handoff = "Machine 6613 evidence notes, as cited in the 2026-11-23 diagram handoff; not fetched or re-verified by this probe";
  const numbers: CalloutNumber[] = [
    ...catalog.rows.map((r) => ({ mpn: r.supplierMpn, mpnKey: r.mpnKey, role: "catalog" as const,
      evidence: `Maytag repair parts list, ${catalog.section?.assembly}, Illus. No. 10 (${r.description})`, source: catalog.section?.sourcePageUrl ?? null })),
    ...supplier.rows.map((r) => ({ mpn: r.supplierMpn, mpnKey: r.mpnKey, role: "supplier_listed" as const,
      evidence: `AppliancePartsPros ${supplier.section?.assembly}, callout 10 (${r.description}, ${r.supplierPartId})`, source: supplier.section?.sourcePageUrl ?? null })),
    { mpn: "W11538088", mpnKey: canonicalizeMpn("W11538088"), role: "observed", evidence: `Board physically read on machine 6613. ${handoff}`, source: null },
    { mpn: "W11543994", mpnKey: canonicalizeMpn("W11543994"), role: "replacement", evidence: `Current service replacement. ${handoff}`, source: null }
  ];
  return { section: catalog.section?.assembly ?? "TOP AND CABINET PARTS", callout: "10", numbers };
}
