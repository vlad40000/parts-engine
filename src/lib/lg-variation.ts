import { brandKey, isUnreadableModel, modelKey } from "./model-key";

/** LG's product-code suffix is not a serial number or a related-model fitment claim. */
export function lgVariation(value: string | null | undefined): string | null {
  const token = (value ?? "").trim().toUpperCase();
  return /^[A-Z0-9]{6,12}$/.test(token) ? token : null;
}

/** An LG model may arrive as WT7200CW.ABWEVUS in an incoming inventory file. */
export function splitLgModel(model: string): { model: string; variation: string | null } {
  const candidate = model.trim().match(/^(.+)[.]([A-Z0-9]{6,12})$/i);
  return candidate && lgVariation(candidate[2])
    ? { model: candidate[1].trim(), variation: lgVariation(candidate[2]) }
    : { model: model.trim(), variation: null };
}

/** Product code format on the LG nameplate: T1780WFFV.ABWEVUS. */
export function variationFromProductCode(productCode: string | null | undefined): string | null {
  const suffix = (productCode ?? "").trim().match(/[.]([A-Z0-9]{6,12})$/i);
  return suffix ? lgVariation(suffix[1]) : null;
}

export function lgIdentity(brand: string, model: string, variationText?: string | null) {
  const key = modelKey(model);
  if (brandKey(brand) !== "LG") {
    return { modelKey: key, identityStatus: (!brand || isUnreadableModel(model) || !key ? "needs_nameplate" : "ok") as "ok" | "needs_nameplate" | "needs_variation" };
  }
  const variation = lgVariation(variationText);
  const identityStatus = !brand || isUnreadableModel(model) || /[?*#]/.test(model) || !key
    ? "needs_nameplate" : variation ? "ok" : "needs_variation";
  // The delimiter cannot appear in a conventional normalized modelKey, so existing
  // brand+model BOMs remain intact while variant-specific catalogs never collide.
  return { modelKey: variation ? `${key}|${variation}` : key, identityStatus: identityStatus as "ok" | "needs_nameplate" | "needs_variation" };
}
