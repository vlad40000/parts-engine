import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";

function importKey() {
  const key = process.env.DIAGRAM_IMPORT_KEY;
  return process.env.VERCEL_ENV !== "preview" && key && key.length >= 32 && key.length <= 256 ? key : undefined;
}

export function diagramImportEnabled() {
  return importKey() !== undefined;
}

export function canImportDiagrams(suppliedKey: FormDataEntryValue | null) {
  const key = importKey();
  if (!key || typeof suppliedKey !== "string" || suppliedKey.length > 256) return false;
  const hash = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(hash(suppliedKey), hash(key));
}
