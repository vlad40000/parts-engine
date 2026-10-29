import { beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import path from "node:path";
import * as schema from "@/src/db/schema";
import type { Db } from "@/src/db/types";
import { upsertFleet } from "@/src/db/queries";
import { getTechNote, loadPlanFacts } from "@/src/db/tech-notes";
import { mapFleetRows } from "@/src/lib/fleet-import";
import { normalizeReading, type NoteReading } from "@/src/lib/tech-notes/reading";

const holder = vi.hoisted(() => ({
  db: null as unknown,
  config: { apiKey: "test-key", quickModel: "quick-model", carefulModel: "careful-model", thinkingLevel: null } as unknown,
  read: null as unknown as (...args: unknown[]) => Promise<{ reading: NoteReading; model: string }>
}));
vi.mock("@/src/db", () => ({ getDb: async () => holder.db, hasDatabase: () => true }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); } }));
vi.mock("@/src/lib/tech-notes/reader", async () => {
  const actual = await vi.importActual<typeof import("@/src/lib/tech-notes/reader")>("@/src/lib/tech-notes/reader");
  return { ...actual, readerConfig: () => holder.config, readCard: (...args: unknown[]) => holder.read(...args) };
});
import { applyNoteAction, discardNoteAction, loadFactsAction, readCardAction, rereadNoteAction, saveDraftAction, startTypedNoteAction } from "@/app/notes/actions";
import { verifyLocationAction } from "@/app/actions";
import { ReaderError } from "@/src/lib/tech-notes/reader";

let db: Db;
const NOW = new Date("2026-05-12T14:00:00Z");
const reading = (no = "4928") => normalizeReading({
  card: "RR-M1", date: { text: "5/11/26", confidence: "high" },
  entries: [{ machine: { text: no, confidence: "high", alternatives: [] }, status: { checked: "READY TO SALE", phrases: [], confidence: "high" },
    location: { name: "Showroom - Main", text: "", confidence: "high" }, grade: "B", price: { text: "$350", confidence: "high" } }]
});
const photo = (bytes = [0xff, 0xd8, 0xff, 1, 2, 3]) => new File([new Uint8Array(bytes)], "card.jpg", { type: "image/jpeg" });
const form = (fields: Record<string, string | File>) => { const f = new FormData(); for (const [k, v] of Object.entries(fields)) f.set(k, v); return f; };
const redirectOf = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return (e as { url?: string }).url ?? Promise.reject(e); } };
const idFrom = (url: string | null) => url!.split("/")[2].split("?")[0];

beforeEach(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  holder.db = db;
  holder.config = { apiKey: "test-key", quickModel: "quick-model", carefulModel: "careful-model", thinkingLevel: null };
  holder.read = vi.fn(async (_cfg: unknown, _photo: unknown, _locations: unknown, tier: unknown) => ({ reading: reading(), model: tier === "careful" ? "careful-model" : "quick-model" }));
  await migrate(drizzle(client), { migrationsFolder: path.join(__dirname, "..", "drizzle") });
  await upsertFleet(db, mapFleetRows([
    { ID: 4928, Availability: "UNCHECKED", ApplianceType: "Washer - Top Load / Agitator", Brand: "Frigidaire", ModelNumber: "FFTW4120SW1", SerialNumber: "TESTKC1", Condition: "U - Unchecked", Location: "Warehouse" },
    { ID: 3314, Availability: "READY TO SALE", ApplianceType: "Washer", Brand: "Kenmore", ModelNumber: "110.25132411", SerialNumber: "TESTC2", Condition: "B - Good", Location: "Showroom - Main" }
  ], NOW).rows);
});

describe("tech note actions", () => {
  it("reads a photo, stores it with its reading, and opens the note", async () => {
    const url = await redirectOf(readCardAction(null, form({ photo: photo() })));
    expect(url).toMatch(/^\/notes\/[0-9a-f-]{36}$/);
    const note = await getTechNote(db, idFrom(url));
    expect(note).toMatchObject({ status: "open", origin: "photo", hasPhoto: true, readerModel: "quick-model", readerError: null, card: "RR-M1" });
    expect(note?.reading?.entries[0].machine.text).toBe("4928");
    const call = (holder.read as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1]).toMatchObject({ mimeType: "image/jpeg" });
    expect(call[2]).toEqual(expect.arrayContaining(["Warehouse", "Showroom - Main"]));
    expect(call[3]).toBe("quick");

    // The same photo again opens the same note instead of reading (and applying) it twice.
    const again = await redirectOf(readCardAction(null, form({ photo: photo() })));
    expect(again).toBe(`/notes/${idFrom(url)}?dup=1`);
    expect((holder.read as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("keeps the photo and says why when the reader fails or is not set up", async () => {
    holder.read = vi.fn(async () => { throw new ReaderError("The card reader is busy or out of quota. Try again in a minute, or type the card.", "rate_limited"); });
    const busy = await getTechNote(db, idFrom(await redirectOf(readCardAction(null, form({ photo: photo([1, 2, 3]) })))));
    expect(busy).toMatchObject({ hasPhoto: true, readerError: "The card reader is busy or out of quota. Try again in a minute, or type the card." });
    expect(busy?.reading?.entries).toHaveLength(1);
    holder.config = null;
    const off = await getTechNote(db, idFrom(await redirectOf(readCardAction(null, form({ photo: photo([4, 5, 6]) })))));
    expect(off?.readerError).toContain("GEMINI_API_KEY");
  });

  it("rejects missing, oversized or non-image uploads without saving anything", async () => {
    expect(await readCardAction(null, form({}))).toMatchObject({ ok: false });
    expect(await readCardAction(null, form({ photo: new File(["x"], "notes.txt", { type: "text/plain" }) }))).toMatchObject({ ok: false, message: "Use a JPEG, PNG, WebP or HEIC photo." });
    expect(await db.select().from(schema.techNotes)).toEqual([]);
  });

  it("re-reads carefully, then applies only once every question is answered and the records are unchanged", async () => {
    const id = idFrom(await redirectOf(readCardAction(null, form({ photo: photo() }))));
    expect(await rereadNoteAction(null, form({ id }))).toMatchObject({ ok: true });
    expect((await getTechNote(db, id))?.readerModel).toBe("careful-model");

    const r = (await getTechNote(db, id))!.reading!;
    const facts = await loadFactsAction(id, r, {});
    // The note was uploaded on the test's clock day; the written date (5/11/26) is what counts.
    expect(facts.uploadedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Object.keys(facts.machines)).toEqual(["4928"]);
    const versions = JSON.stringify({ "4928": facts.machines["4928"].version });

    // An unknown machine number blocks applying until its question is answered.
    const unknown = normalizeReading({ ...r, entries: [{ ...r.entries[0], machine: { text: "4929", confidence: "high", alternatives: [] } }] });
    expect(await applyNoteAction(null, form({ id, reading: JSON.stringify(unknown), answers: "{}", versions }))).toMatchObject({ ok: false, message: "Answer the last question first." });
    // Stale page: the machine changed since the reviewer loaded it.
    expect(await applyNoteAction(null, form({ id, reading: JSON.stringify(r), answers: "{}", versions: JSON.stringify({ "4928": "2020-01-01 00:00:00+00" }) })))
      .toMatchObject({ ok: false, message: expect.stringContaining("#4928 changed since this page opened") });
    expect(await saveDraftAction(id, r, { note: "kept" })).toMatchObject({ ok: true });

    expect(await redirectOf(applyNoteAction(null, form({ id, reading: JSON.stringify(r), answers: "{}", versions })))).toBe(`/notes/${id}`);
    const [m] = await db.select().from(schema.fleetMachines).where(eq(schema.fleetMachines.machineNo, "4928"));
    expect(m).toMatchObject({ availability: "READY TO SALE", condition: "B - Good", location: "Showroom - Main", stickerPrice: "350.00", statusOverride: true, locationOverride: true });
    expect(m.notes).toBe("5/11/26-Location: Showroom - Main. READY TO SALE. Sticker $350.");
    expect((await getTechNote(db, id))?.observedOn).toBe("2026-05-11");

    // Warehouse → Showroom - Main conflicts with the record: verified through the production action.
    const verify = await verifyLocationAction(null, form({ machineNo: "4928", location: "__other", other: "Showroom - WH" }));
    expect(verify).toMatchObject({ ok: true, message: "Verified: #4928 is at Showroom - WH." });
    expect((await db.select().from(schema.fleetMachines).where(eq(schema.fleetMachines.machineNo, "4928")))[0].location).toBe("Showroom - WH");
    expect(await verifyLocationAction(null, form({ machineNo: "4928", location: "Showroom - WH" }))).toMatchObject({ ok: false });
    expect(await applyNoteAction(null, form({ id, reading: JSON.stringify(r), answers: "{}", versions }))).toMatchObject({ ok: false, message: "This note was already applied or discarded." });
    expect(await discardNoteAction(null, form({ id }))).toMatchObject({ ok: false });
  });

  it("starts a typed note and discards it", async () => {
    const url = await redirectOf(startTypedNoteAction());
    const id = idFrom(url);
    expect(await getTechNote(db, id)).toMatchObject({ origin: "manual", hasPhoto: false, status: "open" });
    expect(await loadPlanFacts(db, (await getTechNote(db, id))!.reading!, {})).toMatchObject({ machines: {} });
    expect(await redirectOf(discardNoteAction(null, form({ id })))).toBe("/notes");
    expect((await getTechNote(db, id))?.status).toBe("discarded");
  });
});
