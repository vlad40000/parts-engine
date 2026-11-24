import { load } from "cheerio";
import { hasPlaceholder, identityToken } from "../identity";
import type { Fetcher } from "../types";
import { calloutRow, fetchRecord, finishAttempt, keepDistinct, unreadable } from "./outcome";
import type { DiagramAttempt, DiagramCallout, DiagramQuery, DiagramSection, FetchRecord, UnreadRow } from "./types";

/**
 * Home Depot Repair Parts (Eldis data) files LG models per manufacturer variation:
 * /Models/WT7200CW/MFGModelNumber/ABWEVUS/ is headed "WT7200CW (ABWEVUS) LG Washer - Overview" and links one
 * page per assembly with its drawing key (Selected=…). Captured 2026-11-23: ABWEVUS and ABWETUS list the same
 * three assemblies but a different Top Cover drawing, so a page for one variation is never evidence for another.
 * Section pages canonicalize to the bare model (/Models/WT7200CW/), so a section is tied to the variation by its
 * own URL and by showing the drawing the variation's overview linked.
 */
export const HD_HOST = "www.appliancerepair.homedepot.com";

export function hdVariationUrl(model: string, variation: string): string {
  return `https://${HD_HOST}/Models/${encodeURIComponent(model.trim().toUpperCase())}/MFGModelNumber/${encodeURIComponent(variation.trim().toUpperCase())}/`;
}

type HdPath = { model: string; variation: string | null; section: string | null };

/** Model, variation and section an HD URL names in its path, or null for another host or page type. */
export function hdPath(url: string): HdPath | null {
  try {
    const u = new URL(url);
    if (u.host !== HD_HOST) return null;
    const m = /^\/Models\/([^/]+)(?:\/MFGModelNumber\/([^/]+))?(?:\/Sections\/([^/]+))?\/?$/i.exec(u.pathname);
    if (!m) return null;
    return { model: decodeURIComponent(m[1]), variation: m[2] ? decodeURIComponent(m[2]).toUpperCase() : null, section: m[3] ? decodeURIComponent(m[3]) : null };
  } catch {
    return null;
  }
}

const sameModel = (q: DiagramQuery, model: string) => !!identityToken(model) && identityToken(model) === identityToken(q.model);
const sameVariation = (q: DiagramQuery, variation: string | null) => !!variation && variation.toUpperCase() === (q.variation ?? "").trim().toUpperCase();

export type HdIdentity = { status: "ok" } | { status: "mismatch"; named: string } | { status: "unknown" };

/**
 * An overview page must name this model and variation in every place it names one: its landing URL, its canonical
 * link and its heading "WT7200CW (ABWEVUS) …". The URL alone never confirms a page (a maintenance or challenge page
 * can be served at it), so a page whose own HTML names no model and variation cannot be confirmed.
 */
export function hdOverviewIdentity(q: DiagramQuery, finalUrl: string, html: string): HdIdentity {
  const $ = load(html);
  const named: Array<{ name: string; ok: boolean; inPage: boolean }> = [];
  for (const [url, inPage] of [[finalUrl, false], [$('link[rel="canonical"]').attr("href"), true]] as const) {
    if (!url) continue;
    let path: HdPath | null = null;
    try {
      path = hdPath(new URL(url, finalUrl).toString());
    } catch {
      path = null;
    }
    if (path) named.push({ name: url, ok: sameModel(q, path.model) && sameVariation(q, path.variation) && !path.section, inPage });
  }
  const heading = $("h1").first().text().replace(/\s+/g, " ").trim();
  const h = /^(\S+)\s*\(([A-Z0-9]+)\)/i.exec(heading);
  if (h) named.push({ name: `${h[1]} (${h[2]})`, ok: sameModel(q, h[1]) && sameVariation(q, h[2]), inPage: true });
  const wrong = named.find((n) => !n.ok);
  if (wrong) return { status: "mismatch", named: wrong.name };
  return named.some((n) => n.inPage) ? { status: "ok" } : { status: "unknown" };
}

export type HdIndexEntry = { url: string; title: string; drawingKey: string | null; foreign: boolean };

/** Every assembly link on the overview, each checked to name this model and variation. */
export function hdSectionIndex(q: DiagramQuery, html: string, baseUrl: string): HdIndexEntry[] {
  const $ = load(html);
  const entries = new Map<string, HdIndexEntry>();
  $('a[href*="/Sections/"]').each((_, el) => {
    let url: URL;
    try {
      url = new URL($(el).attr("href") ?? "", baseUrl);
    } catch {
      return;
    }
    const path = hdPath(url.toString());
    const code = url.searchParams.get("mfgModelNum");
    const named = url.searchParams.get("ModelNum");
    const foreign = !path?.section || !sameModel(q, path.model) || !sameVariation(q, path.variation)
      || (!!code && !sameVariation(q, code)) || (!!named && !sameModel(q, named));
    const key = url.pathname.toLowerCase();
    if (entries.has(key)) return;
    entries.set(key, {
      url: url.toString(), foreign,
      title: (path?.section ?? url.pathname).replace(/-/g, " "),
      drawingKey: url.searchParams.get("Selected")?.toUpperCase() ?? null
    });
  });
  return [...entries.values()];
}

export type HdSectionPage = Omit<DiagramSection, "sourcePageUrl"> & { drawingKey: string | null };

/** One assembly page: the full-size drawing and each row's callout (".order-num": F000, A061). */
export function parseHdSection(html: string, pageUrl: string): HdSectionPage {
  const $ = load(html);
  const path = hdPath(pageUrl);
  const assembly = (path?.section ?? "").replace(/-/g, " ").trim();
  const src = $('img[src*="/Schematics/"]').toArray().map((el) => $(el).attr("src") ?? "").find((s) => !/_Thumb\//i.test(s));
  const diagramUrl = src ? new URL(src, pageUrl).toString() : null;
  const drawingKey = src ? (/\/([0-9A-F]{16,})\.[a-z]+$/i.exec(src)?.[1]?.toUpperCase() ?? null) : null;

  const rows: DiagramCallout[] = [];
  const loose = new Map<string, Omit<DiagramCallout, "callout">>();
  const unreadRows: UnreadRow[] = [];
  $(".js-mega-m-part").each((_, el) => {
    const $el = $(el);
    const labelled = (label: RegExp) => $el.find("div").filter((_, d) => label.test($(d).clone().children().remove().end().text().trim()))
      .first().find("span").first().text().trim();
    const mpn = labelled(/^Manufacturer Part #:$/i);
    const retail = labelled(/^Part #:$/i);
    const callout = $el.find(".order-num").first().text().trim();
    const name = $el.find(".mega-m__part__name").first().text();
    const retailId = /^HD\d+$/i.test(retail) ? retail.toUpperCase() : null;
    if (!mpn) {
      unreadRows.push({ callout, supplierPartId: retailId, description: name.replace(/\s+/g, " ").trim(), reason: "no Manufacturer Part # printed" });
      return;
    }
    const row = calloutRow(callout, mpn, name, retailId);
    if (row.callout) rows.push(row);
    else loose.set(`${row.supplierMpn}\u0000${row.supplierPartId ?? ""}`, (({ callout: _c, ...rest }) => rest)(row));
  });
  const { callouts, duplicateRows } = keepDistinct(rows);
  return { assembly, diagramUrl, drawingKey, illustrated: diagramUrl !== null, callouts, uncalloutedRows: [...loose.values()], duplicateRows, unreadRows };
}

export async function acquireHdVariationDiagrams(
  q: DiagramQuery, fetcher: Fetcher, opts: { now?: () => Date; maxSections?: number } = {}
): Promise<DiagramAttempt> {
  const retrievedAt = (opts.now ?? (() => new Date()))().toISOString();
  const fetches: FetchRecord[] = [];
  const missing: string[] = [];
  const sections: DiagramSection[] = [];
  const base = { provider: "homedepot" as const, query: q, retrievedAt, fetches, missing, sections };
  const label = `${q.brand} ${q.model} (${q.variation ?? "no variation"})`;
  if (!q.variation || !/^[A-Z0-9]{6,12}$/i.test(q.variation.trim()) || hasPlaceholder(q.model)) {
    return finishAttempt({ ...base, sourceUrl: null, identity: "not attempted", expectedSections: null,
      blocked: `${label}: a confirmed manufacturer variation and a fully read model are required.` });
  }
  const url = hdVariationUrl(q.model, q.variation);
  const landing = await fetcher(url);
  const bad = unreadable(landing);
  if (bad) {
    fetches.push(fetchRecord(url, landing, bad.outcome, bad.note));
    return finishAttempt({ ...base, sourceUrl: null, identity: "unconfirmed", expectedSections: null,
      blocked: `Variation overview not read: ${bad.note} at ${landing.finalUrl}.` });
  }
  const identity = hdOverviewIdentity(q, landing.finalUrl, landing.html);
  if (identity.status !== "ok") {
    fetches.push(fetchRecord(url, landing, "refused", identity.status === "mismatch" ? `names ${identity.named}` : "names no model"));
    return finishAttempt({ ...base, sourceUrl: null, identity: identity.status === "mismatch" ? `mismatch: ${identity.named}` : "unresolved", expectedSections: null,
      blocked: identity.status === "mismatch"
        ? `${landing.finalUrl} names ${identity.named}, not ${label}; nothing was read.`
        : `${landing.finalUrl} does not name a model and variation; nothing was read.` });
  }
  fetches.push(fetchRecord(url, landing, "read"));
  const confirmed = `landing URL, canonical and heading name ${q.model} (${q.variation.toUpperCase()})`;

  const index = hdSectionIndex(q, landing.html, landing.finalUrl);
  const foreign = index.filter((e) => e.foreign);
  if (foreign.length || !index.length) {
    return finishAttempt({ ...base, sourceUrl: landing.finalUrl, identity: confirmed, expectedSections: index.length,
      blocked: foreign.length
        ? `${foreign.length} of ${index.length} assembly links name another model or variation (${foreign[0].url}); nothing was kept.`
        : "The overview links no assemblies." });
  }
  if (index.length > (opts.maxSections ?? 30)) {
    return finishAttempt({ ...base, sourceUrl: landing.finalUrl, identity: confirmed, expectedSections: index.length,
      blocked: `The overview lists ${index.length} assemblies, more than read per attempt.` });
  }

  let refusedBy: string | null = null;
  for (const entry of index) {
    if (refusedBy) {
      fetches.push({ url: entry.url, status: 0, finalUrl: entry.url, outcome: "skipped", note: `not requested after ${refusedBy}` });
      missing.push(`${entry.title}: not requested after ${refusedBy}`);
      continue;
    }
    const page = await fetcher(entry.url);
    const pageBad = unreadable(page);
    if (pageBad) {
      fetches.push(fetchRecord(entry.url, page, pageBad.outcome, pageBad.note));
      missing.push(`${entry.title}: ${pageBad.note}`);
      if (pageBad.outcome === "blocked") refusedBy = `${pageBad.note} from the host`;
      continue;
    }
    const path = hdPath(page.finalUrl);
    const parsed = parseHdSection(page.html, page.finalUrl);
    const finalCode = new URL(page.finalUrl).searchParams.get("mfgModelNum");
    const wrong = !path?.section || !sameModel(q, path.model) || !sameVariation(q, path.variation) || (!!finalCode && !sameVariation(q, finalCode))
      ? `landed on ${page.finalUrl}`
      : entry.drawingKey && parsed.drawingKey !== entry.drawingKey
        ? `shows drawing ${parsed.drawingKey ?? "none"}, not ${entry.drawingKey} linked from the ${q.variation} overview`
        : null;
    if (wrong) {
      fetches.push(fetchRecord(entry.url, page, "refused", wrong));
      return finishAttempt({ ...base, sourceUrl: landing.finalUrl, identity: confirmed, expectedSections: index.length,
        blocked: `Assembly ${entry.title} ${wrong}; it is not provably ${label}, so nothing was kept.` });
    }
    fetches.push(fetchRecord(entry.url, page, "read"));
    const { drawingKey: _key, ...section } = parsed;
    sections.push({ ...section, sourcePageUrl: page.finalUrl });
  }
  return finishAttempt({ ...base, sourceUrl: landing.finalUrl, identity: confirmed, expectedSections: index.length });
}
