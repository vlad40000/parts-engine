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

/** The "{brand}-{model}" slug of an AppliancePartsPros model page URL, lower case. */
export function appModelSlug(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.host !== APP_HOST) return null;
    return u.pathname.match(/^\/parts-for-(.+)\.html$/i)?.[1].toLowerCase() ?? null;
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
