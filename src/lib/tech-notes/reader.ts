import "server-only";
import { ApiError, GoogleGenAI, ThinkingLevel } from "@google/genai";
import { readerPrompt, READING_JSON_SCHEMA } from "./prompt";
import { normalizeReading, type NoteReading } from "./reading";

/**
 * Card reader: Gemini vision, server-side only. Owner model rule: OCR runs on
 * gemini-3.1-flash-lite; "Re-read carefully" uses gemini-3.5-flash. Both can be changed
 * with environment variables without a code change. The API key never reaches the browser.
 */
export const DEFAULT_QUICK_MODEL = "gemini-3.1-flash-lite";
export const DEFAULT_CAREFUL_MODEL = "gemini-3.5-flash";

export type ReaderTier = "quick" | "careful";
export type ReaderConfig = { apiKey: string; quickModel: string; carefulModel: string; thinkingLevel: ThinkingLevel | null };

export function readerConfig(env: Record<string, string | undefined> = process.env): ReaderConfig | null {
  const apiKey = env.GEMINI_API_KEY?.trim();
  if (!apiKey) return null;
  const level = (env.GEMINI_OCR_THINKING_LEVEL ?? "MEDIUM").trim().toUpperCase();
  const known = Object.values(ThinkingLevel) as string[];
  return {
    apiKey,
    quickModel: env.GEMINI_OCR_MODEL?.trim() || DEFAULT_QUICK_MODEL,
    carefulModel: env.GEMINI_OCR_CAREFUL_MODEL?.trim() || DEFAULT_CAREFUL_MODEL,
    thinkingLevel: level === "OFF" || level === "" ? null : known.includes(level) ? level as ThinkingLevel : ThinkingLevel.MEDIUM
  };
}

export class ReaderError extends Error {
  constructor(message: string, readonly code: string) { super(message); }
}

function toReaderError(error: unknown, model: string): ReaderError {
  if (error instanceof ApiError) {
    if (error.status === 429) return new ReaderError("The card reader is busy or out of quota. Try again in a minute, or type the card.", "rate_limited");
    if (error.status === 401 || error.status === 403) return new ReaderError("The card reader refused the API key. Check GEMINI_API_KEY.", "auth");
    if (error.status === 404) return new ReaderError(`The card reader model ${model} was not found. Check GEMINI_OCR_MODEL / GEMINI_OCR_CAREFUL_MODEL.`, "model");
    if (error.status === 400) return new ReaderError("The card reader could not use this photo. Retake it, or type the card.", "rejected");
  }
  if (error instanceof Error && error.name === "AbortError") return new ReaderError("Reading took too long. Try again, or type the card.", "timeout");
  return new ReaderError("The card could not be read this time. Re-read, retake the photo, or type the card.", "unavailable");
}

const stripFence = (text: string) => text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");

export async function readCard(
  cfg: ReaderConfig,
  photo: { base64: string; mimeType: string },
  locations: string[],
  tier: ReaderTier,
  signal?: AbortSignal
): Promise<{ reading: NoteReading; model: string }> {
  const model = tier === "careful" ? cfg.carefulModel : cfg.quickModel;
  let text = "";
  try {
    const ai = new GoogleGenAI({ apiKey: cfg.apiKey });
    const res = await ai.models.generateContent({
      model,
      contents: [{ role: "user", parts: [{ inlineData: { data: photo.base64, mimeType: photo.mimeType } }, { text: readerPrompt({ locations }) }] }],
      config: {
        responseMimeType: "application/json",
        responseJsonSchema: READING_JSON_SCHEMA,
        maxOutputTokens: 8192,
        ...(cfg.thinkingLevel ? { thinkingConfig: { thinkingLevel: cfg.thinkingLevel } } : {}),
        ...(signal ? { abortSignal: signal } : {})
      }
    });
    text = res.text ?? "";
  } catch (error) {
    throw toReaderError(error, model);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(stripFence(text));
  } catch {
    throw new ReaderError("The card reader's answer could not be used. Try Re-read carefully, or type the card.", "bad_json");
  }
  return { reading: normalizeReading(raw), model };
}
