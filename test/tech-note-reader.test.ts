import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({ generate: vi.fn(), options: [] as unknown[] }));
vi.mock("@google/genai", async () => {
  const actual = await vi.importActual<typeof import("@google/genai")>("@google/genai");
  class GoogleGenAI {
    models = { generateContent: (req: unknown) => sdk.generate(req) };
    constructor(options: unknown) { sdk.options.push(options); }
  }
  return { ...actual, GoogleGenAI };
});
import { ApiError } from "@google/genai";
import { DEFAULT_CAREFUL_MODEL, DEFAULT_QUICK_MODEL, readCard, readerConfig, ReaderError } from "@/src/lib/tech-notes/reader";
import { normalizeReading } from "@/src/lib/tech-notes/reading";
import { readerPrompt, READING_JSON_SCHEMA } from "@/src/lib/tech-notes/prompt";

beforeEach(() => { sdk.generate.mockReset(); sdk.options.length = 0; });

describe("card reader configuration", () => {
  it("is off without a key and follows the owner's model rule by default", () => {
    expect(readerConfig({})).toBeNull();
    expect(readerConfig({ GEMINI_API_KEY: "k" })).toEqual({ apiKey: "k", quickModel: DEFAULT_QUICK_MODEL, carefulModel: DEFAULT_CAREFUL_MODEL, thinkingLevel: "MEDIUM" });
    expect(DEFAULT_QUICK_MODEL).toBe("gemini-3.1-flash-lite");
    expect(DEFAULT_CAREFUL_MODEL).toBe("gemini-3.5-flash");
    expect(readerConfig({ GEMINI_API_KEY: "k", GEMINI_OCR_MODEL: "m1", GEMINI_OCR_CAREFUL_MODEL: "m2", GEMINI_OCR_THINKING_LEVEL: "off" }))
      .toEqual({ apiKey: "k", quickModel: "m1", carefulModel: "m2", thinkingLevel: null });
  });
});

describe("reading a card", () => {
  const cfg = readerConfig({ GEMINI_API_KEY: "k" })!;
  const photo = { base64: "AAAA", mimeType: "image/jpeg" };

  it("sends the photo with the prompt and schema, and normalizes the answer", async () => {
    sdk.generate.mockResolvedValue({ text: "```json\n" + JSON.stringify({ card: "RR-M1", date: { text: "5/11/26", confidence: "high" }, tech: "BV",
      entries: [{ machine: { text: "4928", confidence: "high", alternatives: [] }, status: { checked: "ready to sale", phrases: [], confidence: "high" }, note: "call 843-555-0100" }],
      groups: [], unreadable: [] }) + "\n```" });
    const r = await readCard(cfg, photo, ["Warehouse", "Showroom - Main"], "careful");
    expect(r.model).toBe(DEFAULT_CAREFUL_MODEL);
    expect(r.reading.entries[0]).toMatchObject({ key: "e0", status: { checked: "READY TO SALE" }, note: "call [phone]" });
    expect(r.reading.card).toBe("RR-M1");
    const req = sdk.generate.mock.calls[0][0];
    expect(req.model).toBe(DEFAULT_CAREFUL_MODEL);
    expect(req.contents[0].parts[0]).toEqual({ inlineData: { data: "AAAA", mimeType: "image/jpeg" } });
    expect(req.contents[0].parts[1].text).toContain('"Warehouse", "Showroom - Main"');
    expect(req.config).toMatchObject({ responseMimeType: "application/json", responseJsonSchema: READING_JSON_SCHEMA, thinkingConfig: { thinkingLevel: "MEDIUM" } });
    expect(sdk.options).toEqual([{ apiKey: "k" }]);
  });

  it("turns API failures and unusable answers into messages a person can act on", async () => {
    sdk.generate.mockRejectedValueOnce(new ApiError({ message: "quota", status: 429 }));
    await expect(readCard(cfg, photo, [], "quick")).rejects.toMatchObject({ code: "rate_limited" });
    sdk.generate.mockRejectedValueOnce(new ApiError({ message: "missing", status: 404 }));
    await expect(readCard(cfg, photo, [], "quick")).rejects.toMatchObject({ code: "model", message: expect.stringContaining(DEFAULT_QUICK_MODEL) });
    sdk.generate.mockResolvedValueOnce({ text: "not json" });
    await expect(readCard(cfg, photo, [], "quick")).rejects.toBeInstanceOf(ReaderError);
    sdk.generate.mockRejectedValueOnce(new Error("socket hang up"));
    await expect(readCard(cfg, photo, [], "quick")).rejects.toMatchObject({ code: "unavailable" });
  });
});

describe("normalizing a reading", () => {
  it("drops values outside the card vocabulary and turns group indexes into entry keys", () => {
    const r = normalizeReading({
      card: "XYZ", entries: [
        { machine: { text: "#6371", confidence: "maybe", alternatives: ["6311", "x"] }, grade: "e", symptoms: ["no_heat", "bogus"], parts: [{ mpn: "WP3406108", action: "steal" }, { name: "" }] },
        { machine: { text: "5656" } }
      ],
      groups: [{ text: "ICU!", status: { phrases: ["ICU!"] }, appliesTo: [0, 1, 7] }, { text: "nothing", appliesTo: [0] }]
    });
    expect(r.card).toBe("free");
    expect(r.entries[0]).toMatchObject({ machine: { text: "#6371", confidence: "high", alternatives: ["6311"] }, grade: "", symptoms: ["no_heat"] });
    expect(r.entries[0].parts).toEqual([{ key: "p0", mpn: "WP3406108", name: "", action: "mentioned", otherMachine: "", condition: "", confidence: "high" }]);
    expect(r.groups).toEqual([expect.objectContaining({ key: "g0", appliesTo: ["e0", "e1"] })]);
    expect(normalizeReading(null).entries).toHaveLength(1);
    expect(normalizeReading({ entries: [{ machine: { text: "1" }, parts: [{ name: "pump", action: "suspected" }] }] }).entries[0].parts[0].action).toBe("suspected");
  });

  it("names the intake form and the old cards, the Fleet statuses only, and the part rules", () => {
    const prompt = readerPrompt({ locations: [] });
    expect(prompt).toContain("Form RR-F1, the Roadrunner Standardized Field Intake");
    expect(prompt).toContain("Printed labels: Machine #, Date, Location, Current status, Notes");
    expect(prompt).toContain('"MACHINE SERVICE UPDATE"');
    expect(prompt).toContain("does not need a printed RR-F1 code");
    expect(prompt).toContain("RR-M1");
    expect(prompt).toContain("RR-R1");
    expect(prompt).toContain("UNCHECKED, NEEDS PARTS, PARTS ONLY, PARTS PROGRAM, BEING REPAIRED, READY TO SALE, SOLD, SCRAPPED");
    expect(prompt).toContain('Never turn "Ready for clean" into READY TO SALE, and never choose a status from the location.');
    expect(prompt).toContain('"Needs timer" alone is needed with an empty condition.');
    expect(prompt).toContain('"needs gassing" is a refrigeration service need');
    expect(prompt).toContain("never infer a failed compressor");
    expect(prompt).toContain("never copy customer or staff names");
    expect(READING_JSON_SCHEMA.properties.card.enum).toEqual(["RR-F1", "RR-M1", "RR-R1", "free"]);
  });
});
