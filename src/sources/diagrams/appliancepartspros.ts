import { load } from "cheerio";
import { appSearchUrl, oemFromSlug } from "../appliancepartspros";
import { appPageIdentity, appSectionBelongs, appSectionIdentity, hasPlaceholder, identityToken } from "../identity";
import type { Fetcher } from "../types";
import { calloutRow, fetchRecord, finishAttempt, keepDistinct, unreadable } from "./outcome";
import type { DiagramAttempt, DiagramCallout, DiagramQuery, DiagramSection, FetchRecord, UnreadRow } from "./types";

/**
 * AppliancePartsPros publishes one page per assembly: a heading naming the model and the assembly, a full-size
 * drawing (img …iDiagramFull) and one row per part with its callout label (.product-item-num). The model page
 * lists every assembly. The same identity guards as the BOM lookup apply: the landing page and every section
 * page must name exactly this brand + model, or nothing from the attempt is kept.
 */
const abs = (base: string, href: string) => {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
};

export type AppDiagramIndexEntry = { url: string; title: string };

/** Every assembly the model page lists, in page order. */
export function appDiagramIndex(html: string, baseUrl: string): AppDiagramIndexEntry[] {
  const $ = load(html);
  const entries = new Map<string, AppDiagramIndexEntry>();
  $(".diagram-part-box a[href]").each((_, el) => {
    const url = abs(baseUrl, $(el).attr("href") ?? "");
    if (url && !entries.has(url)) entries.set(url, { url, title: $(el).find(".title").text().replace(/\s+/g, " ").trim() });
  });
  return [...entries.values()];
}

export type AppDiagramSectionPage = Omit<DiagramSection, "sourcePageUrl">;

/** One assembly page: its drawing and every row, callout labels kept exactly as printed. */
export function parseAppDiagramSection(html: string, pageUrl: string): AppDiagramSectionPage {
  const $ = load(html);
  const h1 = $("h1").first().text().replace(/\s+/g, " ").trim();
  const colon = h1.indexOf(": ");
  const assembly = (colon >= 0 ? h1.slice(colon + 2) : h1).replace(/\s*Parts\s*$/i, "").trim();
  const src = $('img[id$="iDiagramFull"]').first().attr("src");
  const diagramUrl = src ? abs(pageUrl, src) : null;

  const rows: DiagramCallout[] = [];
  const loose = new Map<string, Omit<DiagramCallout, "callout">>();
  const unreadRows: UnreadRow[] = [];
  $(".product-item-list-hold").each((_, el) => {
    const $el = $(el);
    const ap = (($el.attr("data-search") ?? "").trim().split(/\s+/)[0] ?? "").toUpperCase();
    const link = $el.find(".product-item-heading h3 a").first();
    const href = link.attr("href") ?? "";
    const callout = $el.find(".product-item-num").first().text().trim();
    // An empty template row (no retail id, no link, no label) is not a listed part.
    if (!ap && !href && !callout) return;
    const oem = /^AP\d+$/.test(ap) ? oemFromSlug(href, ap) : "";
    if (!oem) {
      // e.g. /whirlpool-w11197727-owners-manual-ap7997642.html: the slug does not end in the OEM number.
      unreadRows.push({ callout, supplierPartId: ap || null, description: link.text().replace(/\s+/g, " ").trim(), reason: `no OEM number at the end of ${href || "the row"}` });
      return;
    }
    const row = calloutRow(callout, oem, link.text(), ap);
    if (row.callout) rows.push(row);
    else loose.set(`${row.supplierMpn}\u0000${ap}`, (({ callout: _c, ...rest }) => rest)(row));
  });
  const { callouts, duplicateRows } = keepDistinct(rows);
  return { assembly, diagramUrl, illustrated: diagramUrl !== null, callouts, uncalloutedRows: [...loose.values()], duplicateRows, unreadRows };
}

/** APP files models without a maker's variation code, so a page proves one only by naming it. */
function namesVariation(html: string, variation: string): boolean {
  const $ = load(html);
  const named = identityToken(`${$("h1").first().text()} ${$('link[rel="canonical"]').attr("href") ?? ""}`);
  return named.includes(identityToken(variation));
}

export async function acquireAppDiagrams(
  q: DiagramQuery, fetcher: Fetcher, opts: { now?: () => Date; maxSections?: number } = {}
): Promise<DiagramAttempt> {
  const retrievedAt = (opts.now ?? (() => new Date()))().toISOString();
  const fetches: FetchRecord[] = [];
  const missing: string[] = [];
  const sections: DiagramSection[] = [];
  const base = { provider: "appliancepartspros" as const, query: q, retrievedAt, fetches, missing, sections };
  const label = `${q.brand} ${q.model}${q.variation ? ` (${q.variation})` : ""}`;
  if (hasPlaceholder(q.model)) {
    return finishAttempt({ ...base, sourceUrl: null, identity: "not attempted", expectedSections: null,
      blocked: `Model "${q.model}" has unread characters; read the nameplate first.` });
  }

  const searchUrl = appSearchUrl(q.model);
  const landing = await fetcher(searchUrl);
  const bad = unreadable(landing);
  if (bad) {
    fetches.push(fetchRecord(searchUrl, landing, bad.outcome, bad.note));
    return finishAttempt({ ...base, sourceUrl: null, identity: "unconfirmed", expectedSections: null,
      blocked: `Model page not read: ${bad.note} at ${landing.finalUrl}.` });
  }
  const identity = appPageIdentity(q, landing.finalUrl, landing.html);
  if (identity.status !== "ok") {
    fetches.push(fetchRecord(searchUrl, landing, "refused", identity.status === "mismatch" ? `names ${identity.page}` : "names no model"));
    return finishAttempt({ ...base, sourceUrl: null, identity: identity.status === "mismatch" ? `mismatch: ${identity.page}` : "unresolved", expectedSections: null,
      blocked: identity.status === "mismatch"
        ? `The search landed on ${identity.page}, which is not ${label}; nothing was read.`
        : `The search landed on ${landing.finalUrl}, which does not name its model; nothing was read.` });
  }
  if (q.variation && !namesVariation(landing.html, q.variation)) {
    fetches.push(fetchRecord(searchUrl, landing, "refused", `no manufacturer variation named`));
    return finishAttempt({ ...base, sourceUrl: null, identity: `model ${identity.slugs.join(", ")} without variation`, expectedSections: null,
      blocked: `${landing.finalUrl} names ${q.brand} ${q.model} but no manufacturer variation, so it cannot be shown to be ${q.variation}; nothing was read.` });
  }
  fetches.push(fetchRecord(searchUrl, landing, "read"));
  const confirmed = `landing URL and canonical name ${identity.slugs.join(", ")}`;

  const index = appDiagramIndex(landing.html, landing.finalUrl);
  const foreign = index.filter((entry) => !appSectionBelongs(entry.url, identity.slugs));
  if (foreign.length) {
    return finishAttempt({ ...base, sourceUrl: landing.finalUrl, identity: confirmed, expectedSections: index.length,
      blocked: `${foreign.length} of ${index.length} listed sections belong to another model (${foreign[0].url}); nothing was kept.` });
  }
  const max = opts.maxSections ?? 40;
  if (index.length > max) {
    return finishAttempt({ ...base, sourceUrl: landing.finalUrl, identity: confirmed, expectedSections: index.length,
      blocked: `The model page lists ${index.length} sections, more than the ${max} read per attempt.` });
  }

  let refusedBy: string | null = null;
  for (const entry of index) {
    if (refusedBy) {
      fetches.push({ url: entry.url, status: 0, finalUrl: entry.url, outcome: "skipped", note: `not requested after ${refusedBy}` });
      missing.push(`${entry.title || entry.url}: not requested after ${refusedBy}`);
      continue;
    }
    const page = await fetcher(entry.url);
    const pageBad = unreadable(page);
    if (pageBad) {
      fetches.push(fetchRecord(entry.url, page, pageBad.outcome, pageBad.note));
      missing.push(`${entry.title || entry.url}: ${pageBad.note}`);
      if (pageBad.outcome === "blocked") refusedBy = `${pageBad.note} from the host`;
      continue;
    }
    const named = appSectionBelongs(page.finalUrl, identity.slugs)
      ? appSectionIdentity(q, page.finalUrl, page.html, identity.slugs)
      : { status: "mismatch" as const, named: page.finalUrl };
    if (named.status === "mismatch") {
      fetches.push(fetchRecord(entry.url, page, "refused", `names ${named.named}`));
      return finishAttempt({ ...base, sourceUrl: landing.finalUrl, identity: confirmed, expectedSections: index.length,
        blocked: `Section ${entry.url} loaded a page for ${named.named}, not ${label}; the section list is not provably this model's, so nothing was kept.` });
    }
    if (named.status === "unknown") {
      fetches.push(fetchRecord(entry.url, page, "refused", "names no model"));
      missing.push(`${entry.title || entry.url}: page does not name ${label}`);
      continue;
    }
    fetches.push(fetchRecord(entry.url, page, "read"));
    const parsed = parseAppDiagramSection(page.html, page.finalUrl);
    sections.push({ ...parsed, sourcePageUrl: page.finalUrl });
  }
  return finishAttempt({ ...base, sourceUrl: landing.finalUrl, identity: confirmed, expectedSections: index.length });
}
