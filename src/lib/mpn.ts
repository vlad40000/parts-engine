/**
 * D1 (locked): the cross-app matching key is upper-case with every character
 * outside [A-Z0-9] removed. The display value keeps the original text exactly.
 * WP prefixes and supersessions are aliases (mpn_alias), never stripped here.
 */
export function canonicalizeMpn(raw: string | null | undefined): string {
  return (raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Display form: trimmed only. */
export function displayMpn(raw: string | null | undefined): string {
  return (raw ?? "").trim();
}

/** Whirlpool "WP" service-pack prefix: WPW10545371 is an alias of W10545371. */
export function wpPrefixTarget(canonical: string): string | null {
  return /^WP[A-Z0-9]{5,}$/.test(canonical) ? canonical.slice(2) : null;
}
