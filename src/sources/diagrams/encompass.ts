import { load } from "cheerio";
import { encompassManufacturerCodes, encompassModelUrls, isInvalidModelPage } from "../encompass";
import { encompassModelCode, encompassPageIdentity, hasPlaceholder, identityToken } from "../identity";
import type { Fetcher } from "../types";
import { fetchRecord, finishAttempt, unreadable } from "./outcome";
import type { DiagramAttempt, DiagramQuery, DiagramSection, FetchRecord } from "./types";

/**
 * Encompass. The PartStore model page (GET) links "/Exploded-View-Assembly/{OEM}/{parentId}/{model}", a public page
 * listing every assembly with its ARI drawing (cdn.datamanager.arinet.com, the host the workbook importer accepts).
 * Its callouts and part rows are loaded by the page script from POST /shop/api/ari/?action=getAssemblyInfo, an
 * undocumented endpoint this read-only GET probe does not call (captured 2026-11-23, exploded-views.js rev 18).
 * The main encompass.com host answers scripted requests with a bot-check challenge, which is recorded, never bypassed.
 */
export const ENCOMPASS_CALLOUT_ENDPOINT = "POST /shop/api/ari/?action=getAssemblyInfo";

type ExplodedPath = { oem: string; parentId: string; model: string };

export function explodedViewPath(url: string): ExplodedPath | null {
  try {
    const m = /^\/Exploded-View-Assembly\/([A-Z0-9]+)\/(\d+)\/([^/?#]+)\/?$/i.exec(new URL(url).pathname);
    return m ? { oem: m[1].toUpperCase(), parentId: m[2], model: decodeURIComponent(m[3]) } : null;
  } catch {
    return null;
  }
}

const explodedMatches = (q: DiagramQuery, path: ExplodedPath | null) =>
  !!path && identityToken(path.model) === identityToken(q.model) && encompassManufacturerCodes(q.brand).includes(path.oem);

/** The exploded-view link on a confirmed model page, only when it names this exact model under this brand's code. */
export function encompassExplodedLink(q: DiagramQuery, html: string, baseUrl: string): string | null {
  const $ = load(html);
  for (const el of $('a[href*="/Exploded-View-Assembly/"]').toArray()) {
    try {
      const url = new URL($(el).attr("href") ?? "", baseUrl).toString();
      if (explodedMatches(q, explodedViewPath(url))) return url;
    } catch {
      /* not a link */
    }
  }
  return null;
}

export type EncompassAssembly = { id: string; parentId: string; oem: string; name: string; imageUrl: string | null };

export function parseEncompassExplodedView(html: string): { heading: string; assemblies: EncompassAssembly[] } {
  const $ = load(html);
  const assemblies: EncompassAssembly[] = [];
  $(".exploded-views-thumbnails a[data-hp-assembly]").each((_, el) => {
    const $a = $(el);
    assemblies.push({
      id: $a.attr("data-hp-assembly") ?? "", parentId: $a.attr("data-hp-parentid") ?? "", oem: ($a.attr("data-hp-oem") ?? "").toUpperCase(),
      name: ($a.attr("data-hp-name") ?? $a.find(".thumb-name").text()).replace(/\s+/g, " ").trim(),
      imageUrl: $a.find("img").attr("src") ?? null
    });
  });
  return { heading: $("h1").first().text().replace(/\s+/g, " ").trim(), assemblies };
}

export async function acquireEncompassDiagrams(
  q: DiagramQuery, fetcher: Fetcher, opts: { now?: () => Date } = {}
): Promise<DiagramAttempt> {
  const retrievedAt = (opts.now ?? (() => new Date()))().toISOString();
  const fetches: FetchRecord[] = [];
  const base = { provider: "encompass" as const, query: q, retrievedAt, fetches };
  const label = `${q.brand} ${q.model}`;
  const urls = encompassModelUrls(q.brand, q.model);
  if (!urls.length || hasPlaceholder(q.model)) {
    return finishAttempt({ ...base, sections: [], missing: [], sourceUrl: null, identity: "not attempted", expectedSections: null,
      blocked: urls.length ? `Model "${q.model}" has unread characters.` : `No Encompass manufacturer code for "${q.brand}".` });
  }

  let modelPage: { url: string; exploded: string } | null = null;
  const notes: string[] = [];
  for (const url of urls) {
    const res = await fetcher(url);
    const bad = unreadable(res);
    if (bad) {
      fetches.push(fetchRecord(url, res, bad.outcome, bad.note));
      notes.push(`${url}: ${bad.note}`);
      continue;
    }
    if (isInvalidModelPage(res.html) || /Invalid-Model/i.test(res.finalUrl)) {
      fetches.push(fetchRecord(url, res, "missing", "Encompass answered that the model does not exist"));
      notes.push(`${url}: no such model at Encompass`);
      continue;
    }
    const named = encompassModelCode(res.finalUrl) === encompassModelCode(url)
      ? encompassPageIdentity(q, url, res.html)
      : { status: "mismatch" as const, named: res.finalUrl };
    if (named.status !== "ok") {
      const why = named.status === "mismatch" ? `names ${named.named}` : "names no model";
      fetches.push(fetchRecord(url, res, "refused", why));
      notes.push(`${url}: ${why}`);
      continue;
    }
    const exploded = encompassExplodedLink(q, res.html, res.finalUrl);
    fetches.push(fetchRecord(url, res, "read", exploded ? null : "no exploded view for this exact model"));
    if (exploded) {
      modelPage = { url: res.finalUrl, exploded };
      break;
    }
    notes.push(`${url}: model confirmed but no exploded view links this exact model`);
  }
  if (!modelPage) {
    return finishAttempt({ ...base, sections: [], missing: [], sourceUrl: null, identity: "unconfirmed", expectedSections: null,
      blocked: `No confirmed Encompass exploded view: ${notes.join("; ")}.` });
  }
  if (q.variation) {
    return finishAttempt({ ...base, sections: [], missing: [], sourceUrl: null, identity: `model page ${modelPage.url} without variation`, expectedSections: null,
      blocked: `Encompass files ${q.model} without a manufacturer variation, so it cannot be shown to be ${q.variation}.` });
  }

  const page = await fetcher(modelPage.exploded);
  const bad = unreadable(page);
  if (bad) {
    fetches.push(fetchRecord(modelPage.exploded, page, bad.outcome, bad.note));
    return finishAttempt({ ...base, sections: [], missing: [], sourceUrl: null, identity: `model page ${modelPage.url}`, expectedSections: null,
      blocked: `Exploded view not read: ${bad.note} at ${page.finalUrl}.` });
  }
  const view = parseEncompassExplodedView(page.html);
  const headingModel = view.heading.split(" ")[0] ?? "";
  if (!explodedMatches(q, explodedViewPath(page.finalUrl)) || (headingModel && identityToken(headingModel) !== identityToken(q.model))
    || view.assemblies.some((a) => a.parentId !== explodedViewPath(page.finalUrl)?.parentId)) {
    fetches.push(fetchRecord(modelPage.exploded, page, "refused", `landed on ${page.finalUrl} headed "${view.heading}"`));
    return finishAttempt({ ...base, sections: [], missing: [], sourceUrl: null, identity: `model page ${modelPage.url}`, expectedSections: null,
      blocked: `The exploded view at ${page.finalUrl} ("${view.heading}") is not provably ${label}; nothing was kept.` });
  }
  fetches.push(fetchRecord(modelPage.exploded, page, "read"));
  const sections: DiagramSection[] = view.assemblies.map((a) => ({
    assembly: a.name, sourcePageUrl: `${page.finalUrl}#${a.id}`, diagramUrl: a.imageUrl, illustrated: a.imageUrl !== null,
    callouts: [], uncalloutedRows: [], duplicateRows: 0, unreadRows: []
  }));
  const missing = view.assemblies.length
    ? [`callout rows for all ${view.assemblies.length} assemblies: served only by ${ENCOMPASS_CALLOUT_ENDPOINT}, which this GET-only probe does not call`]
    : [];
  return finishAttempt({ ...base, sections, missing, sourceUrl: page.finalUrl, expectedSections: view.assemblies.length,
    identity: `model page ${modelPage.url}; exploded view path and heading "${view.heading}" name ${q.model}` });
}
