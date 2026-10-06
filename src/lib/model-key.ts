/**
 * Model identity is brand-aware: join on brandKey + modelKey, never model alone.
 * modelKey matches Ledger's supplier lookup normalisation (spaces, dots, dashes
 * removed) but keeps slashes, because Samsung/LG revision suffixes matter.
 */
export function brandKey(brand: string | null | undefined): string {
  return (brand ?? "").trim().toUpperCase().replace(/\s+/g, " ");
}

export function modelKey(model: string | null | undefined): string {
  return (model ?? "").trim().toUpperCase().replace(/[\s.\-]/g, "");
}

const UNREADABLE = /^(|N\/?A|NONE|UNKNOWN|UNK|\?+|NO ?NAME ?PLATE|NO ?TAG|NO ?LABEL|NO ?MODEL|MISSING|-+)$/;

export function isUnreadableModel(model: string | null | undefined): boolean {
  return UNREADABLE.test((model ?? "").trim().toUpperCase());
}

export function modelIdentity(brand: string, model: string) {
  return { brandKey: brandKey(brand), modelKey: modelKey(model) };
}
