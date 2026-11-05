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

/** Longest alias chain followed. Real Whirlpool chains seen so far are 3 hops. */
export const MAX_ALIAS_HOPS = 16;

export type AliasChain = {
  /** Where the chain ends: the key with no further alias, or the start itself on a loop. */
  canonical: string;
  /** Every key visited after the start, in order. */
  hops: string[];
  /** True when the chain revisits a key or runs past MAX_ALIAS_HOPS; the start is then left unresolved. */
  loop: boolean;
};

/**
 * Follow persisted aliases to the end of the chain: W10142630 → W11375994 → WP285655 → 285655.
 * Aliases are relationships, so every hop stays stored; this only answers "which MPN does this
 * number land on now". A loop is bad data and resolves to nothing rather than to an arbitrary key.
 */
export function resolveAliasChain(start: string, next: (key: string) => string | undefined): AliasChain {
  const hops: string[] = [];
  const seen = new Set([start]);
  let key = start;
  for (let i = 0; i < MAX_ALIAS_HOPS; i += 1) {
    const target = next(key);
    if (target === undefined || target === key) return { canonical: key, hops, loop: false };
    if (seen.has(target)) return { canonical: start, hops: [...hops, target], loop: true };
    seen.add(target);
    hops.push(target);
    key = target;
  }
  return { canonical: start, hops, loop: true };
}

/** Whirlpool "WP" service-pack prefix: WPW10545371 is an alias of W10545371. */
export function wpPrefixTarget(canonical: string): string | null {
  return /^WP[A-Z0-9]{5,}$/.test(canonical) ? canonical.slice(2) : null;
}
