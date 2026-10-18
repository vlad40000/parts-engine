import { load } from "cheerio";
import type { ModelQuery } from "./types";

/**
 * Supplier page identity. A supplier search follows redirects and can land on a page for
 * another model: a longer revision (GR440LXLP → GR440LXLP0), the same number filed under an
 * unrelated maker, or a different model entirely. A page is read for a query only when its own
 * identity names exactly that model under a compatible brand; otherwise nothing from it is saved.
 */

/** Case, accents and separators (space . - / |) never distinguish one model from another. */
export function identityToken(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** "?", "*" and "#" stand for unread nameplate characters, so the model cannot be matched exactly. */
export function hasPlaceholder(model: string): boolean {
  return /[?*#]/.test(model);
}

/** Supplier spellings of one brand. */
const SPELLINGS: Record<string, string> = {
  GENERALELECTRIC: "GE", HP: "HOTPOINT", TAP: "TAPPAN", KENMOREELITE: "KENMORE", ALLIANCELAUNDRYSYSTEMS: "ALLIANCE"
};

/**
 * Brands of one manufacturer, which suppliers file under each other's names (audit 2026-10-17:
 * 155 of 2,789 AppliancePartsPros BOMs, e.g. KitchenAid models under Whirlpool, Hotpoint under GE).
 * Kenmore is a retailer brand made by several of these, so it is compatible only with itself.
 */
const MANUFACTURERS: string[][] = [
  ["WHIRLPOOL", "MAYTAG", "KITCHENAID", "JENNAIR", "AMANA", "ROPER", "ESTATE", "ADMIRAL", "INGLIS"],
  ["GE", "HOTPOINT", "MONOGRAM", "CAFE"],
  ["FRIGIDAIRE", "ELECTROLUX", "GIBSON", "TAPPAN", "KELVINATOR", "WHITEWESTINGHOUSE"],
  ["BOSCH", "THERMADOR", "GAGGENAU"],
  ["SPEEDQUEEN", "ALLIANCE"]
];

const brandOf = (brand: string) => {
  const token = identityToken(brand);
  return SPELLINGS[token] ?? token;
};

export function brandsCompatible(requested: string, page: string): boolean {
  const a = brandOf(requested);
  const b = brandOf(page);
  if (!a || !b) return false;
  return a === b || MANUFACTURERS.some((m) => m.includes(a) && m.includes(b));
}

// ---------------------------------------------------------------------------
// AppliancePartsPros: model pages are "/parts-for-{brand}-{model}.html" and section pages
// "/{section}-parts-for-{brand}-{model}.html". Brand and model slugs may both contain hyphens.
// ---------------------------------------------------------------------------
const APP_HOST = "www.appliancepartspros.com";

/**
 * The "{brand}-{model}" slug of an AppliancePartsPros model page URL, lower case. "/parts-for-model-…"
 * is another page type (104 production searches, audit 2026-10-17, none listing parts sections) that no
 * fixture shows, so it names no model this check can confirm or refuse.
 */
export function appModelSlug(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.host !== APP_HOST) return null;
    return u.pathname.match(/^\/parts-for-(?!model-)(.+)\.html$/i)?.[1].toLowerCase() ?? null;
  } catch {
    return null;
  }
}

/** True when the slug names exactly this model under a compatible brand. */
export function appSlugMatches(q: ModelQuery, slug: string): boolean {
  if (hasPlaceholder(q.model)) return false;
  const model = identityToken(q.model);
  if (!model) return false;
  for (let i = slug.indexOf("-"); i > 0; i = slug.indexOf("-", i + 1)) {
    if (identityToken(slug.slice(i + 1)) === model && brandsCompatible(q.brand, slug.slice(0, i))) return true;
  }
  return false;
}

export type AppPageIdentity =
  | { status: "ok"; slugs: string[] }
  | { status: "mismatch"; page: string }
  | { status: "unknown" };

/**
 * The page names itself in its landing URL (after redirects) and its canonical link.
 * Every name present must match the query; a page with neither cannot be confirmed.
 */
export function appPageIdentity(q: ModelQuery, finalUrl: string, html: string): AppPageIdentity {
  const href = load(html)('link[rel="canonical"]').attr("href");
  let canonical: string | null = null;
  try {
    canonical = href ? new URL(href, finalUrl).toString() : null;
  } catch {
    canonical = null;
  }
  const named = [finalUrl, canonical].flatMap((url) => {
    const slug = url ? appModelSlug(url) : null;
    return url && slug ? [{ url, slug }] : [];
  });
  if (!named.length) return { status: "unknown" };
  const wrong = named.find((p) => !appSlugMatches(q, p.slug));
  return wrong ? { status: "mismatch", page: wrong.url } : { status: "ok", slugs: [...new Set(named.map((p) => p.slug))] };
}

/** A section page belongs to a confirmed model page when its path ends "-parts-for-{slug}.html". */
export function appSectionBelongs(url: string, slugs: string[]): boolean {
  try {
    const u = new URL(url);
    const path = u.pathname.toLowerCase();
    return u.host === APP_HOST && slugs.some((slug) => path.endsWith(`-parts-for-${slug}.html`));
  } catch {
    return false;
  }
}

/**
 * The "{brand} {model}" a section page's heading names, or null when it names none. Section pages are headed "Parts for
 * Hot Point HTDX100ED3WW: Backsplash, Blower & Drive Assembly Parts"; a heading without that opening names a model only
 * when it ends in this model's number ("Maytag MVWX655DW1: Cover Sheet Parts"), so a notice ("We'll be right back",
 * "Error 503: Service Unavailable") names none.
 */
function appSectionHeading(q: ModelQuery, h1: string): string | null {
  const text = h1.replace(/\s+/g, " ").trim();
  const named = (text.includes(": ") ? text.slice(0, text.indexOf(": ")) : text).trim();
  if (/^parts for /i.test(named)) return named.slice("parts for ".length).trim() || null;
  const model = identityToken(q.model);
  const words = named.split(" ");
  return model && words.some((_, i) => identityToken(words.slice(i).join(" ")) === model) ? named : null;
}

export type AppSectionIdentity = { status: "ok" } | { status: "mismatch"; named: string } | { status: "unknown" };

/**
 * What a section page's own HTML says it is. Every captured section page has a canonical link to itself and a
 * heading naming its model ("Parts for Hot Point HTDX100ED3WW: Backsplash, Blower & Drive Assembly Parts"). Each one
 * present must name this model: the link by belonging to the confirmed model page, the heading by naming exactly this
 * model under a compatible brand, as a model page slug must. A page whose link and heading disagree is refused. A
 * maintenance, challenge or changed page served at the section URL names neither, and lists no parts either, so
 * an empty section counts as read only when its page names this model.
 */
export function appSectionIdentity(q: ModelQuery, finalUrl: string, html: string, slugs: string[]): AppSectionIdentity {
  const $ = load(html);
  const href = $('link[rel="canonical"]').attr("href");
  let canonical: string | null = null;
  if (href) {
    try {
      canonical = new URL(href, finalUrl).toString();
    } catch {
      return { status: "unknown" };
    }
    if (!appSectionBelongs(canonical, slugs)) return { status: "mismatch", named: canonical };
  }
  // A heading spells its brand and model as the slug does, with spaces for hyphens.
  const heading = appSectionHeading(q, $("h1").first().text());
  if (heading && !appSlugMatches(q, heading.replace(/ /g, "-"))) return { status: "mismatch", named: heading };
  return canonical || heading ? { status: "ok" } : { status: "unknown" };
}

// ---------------------------------------------------------------------------
// Encompass: "/model/{prefix}{model}", optionally "/0001/" or "/_/N" after it.
// ---------------------------------------------------------------------------
/** The model code of an Encompass URL ("WHIMVWX655DW1", "SMGDV45H7000EWA2"), or null. */
export function encompassModelCode(url: string): string | null {
  try {
    const m = new URL(url).pathname.match(/^\/model\/([^/]+)/i);
    return m ? identityToken(decodeURIComponent(m[1])) || null : null;
  } catch {
    return null;
  }
}

export type EncompassPageIdentity = { status: "ok" } | { status: "mismatch"; named: string } | { status: "unknown" };

/**
 * What an Encompass page's HTML says it is, whatever URL served it: its canonical link (fixture MVWX655DW1-live)
 * and the modelNumber of its embedded model record (fixture model-page). Every name present must be this model;
 * a page with neither cannot be confirmed.
 */
export function encompassPageIdentity(q: ModelQuery, url: string, html: string): EncompassPageIdentity {
  const named: Array<{ name: string; ok: boolean }> = [];
  const href = load(html)('link[rel="canonical"]').attr("href");
  if (href) {
    let canonical: string | null = null;
    try {
      canonical = new URL(href, url).toString();
    } catch {
      canonical = null;
    }
    named.push({ name: canonical ?? href, ok: !!canonical && encompassModelCode(canonical) === encompassModelCode(url) });
  }
  const model = identityToken(q.model);
  // The model record sits in the escaped Next.js payload (\"modelNumber\":\"MEDC465HW0\") or in plain JSON.
  for (const m of html.matchAll(/\\?"modelNumber\\?"\s*:\s*\\?"([^"\\]*)/g)) {
    if (identityToken(m[1])) named.push({ name: `model ${m[1]}`, ok: identityToken(m[1]) === model });
  }
  if (!named.length) return { status: "unknown" };
  const wrong = named.find((n) => !n.ok);
  return wrong ? { status: "mismatch", named: wrong.name } : { status: "ok" };
}
