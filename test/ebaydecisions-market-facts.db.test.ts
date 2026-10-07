import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as schema from "@/src/db/schema";
import type { Db } from "@/src/db/types";
import { getSettings, mpnDetail, mpnIndex, roadrunnerPerformance, saveModelBom, saveSettings, upsertFleet, upsertSaleEvents } from "@/src/db/queries";
import { qualify } from "@/src/lib/economics";
import { mapFleetRows } from "@/src/lib/fleet-import";
import { libraryAppliance } from "@/src/lib/part-family";
import {
  ebayDecisionsConfig, EBAYDECISIONS_ROUTE, EbayDecisionsError, fetchMarketFacts, parseMarketFactsResponse, planMarketFacts, type ProviderFact
} from "@/src/lib/ebaydecisions";
import type { ChainResult } from "@/src/sources/chain";
import type { SupplierRow } from "@/src/sources/types";
import { importMarketAction, refreshMarketFactsAction, saveMarketAction, saveMpnManualAction } from "@/app/actions";

// Server actions run against this file's PGlite database.
const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/src/db", () => ({ getDb: async () => holder.db, hasDatabase: () => true }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const ROOT = path.join(__dirname, "..");
const URL_ = "https://ebd.example";
const KEY = "pe-test-integration-key-0123456789";
const BOARD = "W11165528";
const PUMP = "W10006355";
const LID = "W10820048";
const UNREG = "W99999999";
let db: Db;

const part = (mpn: string, description: string, price: number): SupplierRow => ({
  mpnDisplay: mpn, mpnCanonical: mpn, description, diagramId: "1", supplierPartId: null, newPrice: price, nla: false
});
const chain = (rows: SupplierRow[]): ChainResult => ({
  status: "found",
  winner: { supplier: "encompass", status: "found", rows, droppedRows: 0, sourceUrl: "https://x", visited: [], warnings: [], elapsedMs: 1 },
  attempts: [{ supplier: "encompass", status: "found", droppedRows: 0, sourceUrl: "https://x", visited: [], warnings: [], elapsedMs: 1 }]
});
const washer = (id: number, availability = "UNCHECKED") =>
  ({ ID: id, Availability: availability, ApplianceType: "Washer - Top Load", Brand: "Maytag", ModelNumber: "MVWX655DW1", SerialNumber: "" });
const form = (fields: Record<string, string | string[]>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const x of [v].flat()) f.append(k, x);
  return f;
};
const allFacts = async () => (await db.select().from(schema.marketFacts)).sort((a, b) => a.mpnCanonical.localeCompare(b.mpnCanonical));
const facts = async (mpn: string) => (await allFacts()).find((r) => r.mpnCanonical === mpn);

const sold90 = (p: Partial<NonNullable<Extract<ProviderFact, { status: "found" }>["sold90"]>> = {}) => ({
  soldQty: 12, avgSoldPrice: 95.5, avgBuyerShipping: 11.25, sellThroughPct: 42.5,
  source: "ebay_insights" as const, priceBasis: "sold" as const, capturedAt: "2026-09-20T23:30:00.000Z", ...p
});
const active = (p: Record<string, unknown> = {}) => ({
  activeQty: 37, askingPrice: 120, askingShipping: 9.5, source: "ebay_browse" as const, sampleSize: 37, truncated: false,
  capturedAt: "2026-10-05T08:00:00.000Z", ...p
});
const found = (mpnKey: string, s: unknown, a: unknown) => ({ mpnKey, mpnDisplay: mpnKey, status: "found", sold90: s, active: a });
const unregistered = (mpnKey: string) => ({ mpnKey, mpnDisplay: null, status: "unregistered", sold90: null, active: null });
const envelope = (factsList: unknown[]) => ({ schemaVersion: 1, generatedAt: "2026-10-06T12:00:00.000Z", facts: factsList });

/** Records each request; answers with `body` (or a function of the request keys). */
function provider(body: unknown | ((keys: string[]) => unknown), status = 200) {
  const calls: Array<{ url: string; init: RequestInit; keys: string[] }> = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const keys = JSON.parse(String(init?.body)).mpns as string[];
    calls.push({ url: String(url), init: init!, keys });
    const payload = typeof body === "function" ? (body as (k: string[]) => unknown)(keys) : body;
    return new Response(typeof payload === "string" ? payload : JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls };
}
const configure = () => {
  process.env.EBAYDECISIONS_URL = URL_ + "/";
  process.env.EBAYDECISIONS_API_KEY = KEY;
};

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  holder.db = db;
  await migrate(drizzle(client), { migrationsFolder: path.join(ROOT, "drizzle") });
  await upsertFleet(db, mapFleetRows([washer(1), washer(2), washer(3, "SOLD")]).rows);
  await saveModelBom(db, {
    brandKey: "MAYTAG", modelKey: "MVWX655DW1", brandDisplay: "Maytag", modelDisplay: "MVWX655DW1",
    result: chain([part(BOARD, "Washer Electronic Control Board", 180), part(PUMP, "Drain Pump", 60), part(LID, "Lid Lock", 70), part(UNREG, "Agitator", 40)])
  });
});

afterEach(() => {
  delete process.env.EBAYDECISIONS_URL;
  delete process.env.EBAYDECISIONS_API_KEY;
  vi.unstubAllGlobals();
});

describe("EbayDecisions client (provider schemaVersion 1)", () => {
  it("config is null unless both URL and key are set", () => {
    expect(ebayDecisionsConfig({})).toBeNull();
    expect(ebayDecisionsConfig({ EBAYDECISIONS_URL: URL_ })).toBeNull();
    expect(ebayDecisionsConfig({ EBAYDECISIONS_API_KEY: KEY })).toBeNull();
    expect(ebayDecisionsConfig({ EBAYDECISIONS_URL: URL_ + "//", EBAYDECISIONS_API_KEY: KEY })).toEqual({ url: URL_, apiKey: KEY });
  });

  it("4. sends one POST of D1 keys with a bearer key and a bounded timeout", async () => {
    const { calls } = provider((keys: string[]) => envelope(keys.map(unregistered)));
    await fetchMarketFacts({ url: URL_, apiKey: KEY }, ["w11165528", "W1116-5528", " W10006355 ", "--"]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(URL_ + EBAYDECISIONS_ROUTE);
    expect(calls[0].keys).toEqual([BOARD, PUMP]);
    expect(calls[0].init.method).toBe("POST");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it("refuses more than 100 MPNs without calling the provider", async () => {
    const { fn } = provider(envelope([]));
    const many = Array.from({ length: 101 }, (_, i) => `X${i}`);
    await expect(fetchMarketFacts({ url: URL_, apiKey: KEY }, many)).rejects.toThrow(EbayDecisionsError);
    expect(fn).not.toHaveBeenCalled();
  });

  it("times out instead of hanging", async () => {
    const hang = vi.fn((_u: unknown, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    }));
    await expect(fetchMarketFacts({ url: URL_, apiKey: KEY }, [BOARD], { fetchImpl: hang as unknown as typeof fetch, timeoutMs: 20 }))
      .rejects.toThrow("did not answer in time");
  });

  it("5. fails closed on unauthorized, wrong version, wrong shape, or unrequested keys; errors never carry the key", async () => {
    const cases: Array<[unknown, number]> = [
      [{ error: "Unauthorized." }, 401],
      [{ error: "The integration API is not configured." }, 503],
      [{ error: "boom" }, 500],
      ["<html>not json</html>", 200],
      [{ ...envelope([unregistered(BOARD)]), schemaVersion: 2 }, 200],
      [envelope([found(BOARD, sold90({ soldQty: -1 }), null)]), 200],
      [envelope([found(BOARD, sold90({ sellThroughPct: "42" as unknown as number }), null)]), 200],
      [envelope([found(BOARD, sold90({ capturedAt: "yesterday" }), null)]), 200],
      [envelope([{ ...unregistered(BOARD), sold90: sold90() }]), 200],
      [envelope([unregistered("W00000000")]), 200],
      [envelope([unregistered(BOARD), unregistered(BOARD)]), 200],
      [envelope([unregistered("w11165528")]), 200]
    ];
    for (const [body, status] of cases) {
      provider(body, status);
      const error = await fetchMarketFacts({ url: URL_, apiKey: KEY }, [BOARD]).then(() => null, (e: unknown) => e);
      expect(error, JSON.stringify(body)).toBeInstanceOf(EbayDecisionsError);
      expect(String((error as Error).message)).not.toContain(KEY);
    }
  });

  it("16 / 2. consumer code opens no database and the key stays server-side", () => {
    const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
    const client = read("src/lib/ebaydecisions.ts");
    expect(client.startsWith('import "server-only";')).toBe(true);
    // The only DB-module reference is a type-only import of Parts Engine's own patch types.
    expect(client).toMatch(/import type \{[^}]+\} from "@\/src\/db\/queries";/);
    expect(client).not.toMatch(/from "@\/src\/db"|pglite|neon|postgres|drizzle|DATABASE_URL/i);
    // Nothing rendered to the browser reads the key.
    for (const f of ["app/mpns/page.tsx", "src/components/forms.tsx"]) expect(read(f)).not.toMatch(/process\.env|apiKey|ebayDecisionsConfig\(/);
    expect(read("src/components/forms.tsx")).not.toContain("ebaydecisions");
  });
});

describe("Live refresh: market_facts writes", () => {
  it("1. without integration config the action does nothing and the CSV import still works", async () => {
    const { fn } = provider(envelope([]));
    const res = await refreshMarketFactsAction(null, form({ mpn: [BOARD] }));
    expect(res).toMatchObject({ ok: false, message: expect.stringContaining("not configured") });
    expect(fn).not.toHaveBeenCalled();

    const upload = new FormData();
    upload.set("file", new File([`mpn,sold90,avg_price,avg_ship,sell_through_pct,active_qty,researched_at\n${LID},4,70,9,25,8,2026-08-01`], "m.csv", { type: "text/csv" }));
    expect(await importMarketAction(null, upload)).toMatchObject({ ok: true });
    expect(await facts(LID)).toMatchObject({ sold90: 4, source: "market_import", researchedAt: "2026-08-01" });
  });

  it("5. unauthorized and malformed responses write nothing", async () => {
    configure();
    const before = await allFacts();
    for (const [body, status] of [[{ error: "Unauthorized." }, 401], [{ schemaVersion: 1, facts: "nope" }, 200]] as const) {
      provider(body, status);
      const res = await refreshMarketFactsAction(null, form({ mpn: [BOARD, LID] }));
      expect(res.ok).toBe(false);
      expect(res.message).toContain("Nothing was saved");
      expect(res.message).not.toContain(KEY);
    }
    expect(await allFacts()).toEqual(before);
  });

  it("3/4. one rendered queue page → one batch request of its D1 MPNs", async () => {
    configure();
    const { rows } = await mpnIndex(db, { view: "queue" }, 100, 0);
    const pageKeys = rows.map((r) => r.mpn_canonical);
    expect(pageKeys).toEqual(expect.arrayContaining([BOARD, PUMP, UNREG]));
    const { calls } = provider((keys: string[]) => envelope(keys.map(unregistered)));
    const res = await refreshMarketFactsAction(null, form({ mpn: pageKeys }));
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].keys).toEqual(pageKeys);
  });

  // Local fields set by the owner before the refresh: none of these may move.
  const LOCAL = { freeShipping: true, shipCost: "14.00", qtyOnHand: 3 };
  const MANUAL = { removalMin: "22.0", packagingCost: "4.50", strategicExceptionApproved: true };

  it("6–12. maps sold90 and active exactly, keeps local fields, and never advances freshness from active facts", async () => {
    configure();
    // Existing state: BOARD has local fields + an older import; LID has research from the CSV test; UNREG has a manual row.
    await saveMarketAction(form({ mpn: BOARD, sold90: "2", avgPrice: "80", avgShip: "10", sellThroughPct: "20", activeQty: "5",
      qtyOnHand: "3", researchedAt: "2026-06-01", freeShipping: "on", shipCost: "14" }));
    await saveMpnManualAction(form({ mpn: BOARD, removalMin: "22", packagingCost: "4.50", strategicExceptionApproved: "on" }));
    await saveMarketAction(form({ mpn: UNREG, sold90: "9", avgPrice: "33", avgShip: "", sellThroughPct: "15", activeQty: "4", researchedAt: "2026-07-07" }));
    const lidBefore = await facts(LID);
    const unregBefore = await facts(UNREG);

    provider(envelope([
      found(BOARD, sold90(), active()),
      found(PUMP, sold90({ sellThroughPct: null, avgBuyerShipping: null, soldQty: null }), null),
      found(LID, null, active({ activeQty: 61 })),
      unregistered(UNREG)
    ]));
    const res = await refreshMarketFactsAction(null, form({ mpn: [BOARD, PUMP, LID, UNREG, "W12345678"] }));
    expect(res).toMatchObject({ ok: true, message: "Refreshed market facts for 2 of 5 MPNs from EbayDecisions." });
    expect(res.details).toEqual([
      "Refreshed: 2.",
      "Registered but no 90-day research: 1 (sold facts and research date left as they were).",
      "Not registered in EbayDecisions: 1 (existing facts kept).",
      "Failed: 1."
    ]);

    // 6/7/9/10/12: sold90 → sold fields, active → active_qty only, SOLD capture date, local fields untouched.
    expect(await facts(BOARD)).toMatchObject({
      sold90: 12, avgPrice: "95.50", avgShip: "11.25", sellThroughPct: "42.50", sellThroughSource: "research",
      activeQty: 37, researchedAt: "2026-09-20", source: "ebaydecisions_api", ...LOCAL
    });
    const board = (await mpnDetail(db, BOARD))!.mpn;
    expect({ removalMin: board.removal_min, packagingCost: board.packaging_cost, strategicExceptionApproved: board.strategic_exception_approved }).toEqual(MANUAL);

    // 8: missing values stay null, never zero; no sell-through is derived; no active snapshot leaves active_qty alone.
    expect(await facts(PUMP)).toMatchObject({
      sold90: null, avgPrice: "95.50", avgShip: null, sellThroughPct: null, sellThroughSource: null, activeQty: null, researchedAt: "2026-09-20"
    });

    // 10: active-only facts update active_qty but neither sold facts nor researched_at.
    expect(await facts(LID)).toEqual({ ...lidBefore, activeQty: 61, updatedAt: expect.any(Date) });

    // 11: unregistered and failed keys write nothing.
    expect(await facts(UNREG)).toEqual(unregBefore);
    expect(await facts("W12345678")).toBeUndefined();
  });

  it("an active-only fact for an MPN with no market row creates no sold research and no freshness", async () => {
    configure();
    const fresh = "W55555555";
    provider(envelope([found(fresh, null, active({ activeQty: 2 }))]));
    await refreshMarketFactsAction(null, form({ mpn: [fresh] }));
    expect(await facts(fresh)).toMatchObject({ activeQty: 2, sold90: null, avgPrice: null, sellThroughPct: null, researchedAt: null });
  });

  it("13. PE-4 qualification consumes refreshed facts through the unchanged formulas", async () => {
    await saveSettings(db, { ...(await getSettings(db)), minimumSellThroughPct: 30, minimumProfitMarginPct: 25 });
    const s = await getSettings(db);
    const d = (await mpnDetail(db, BOARD))!;
    expect(d.mpn.qualification).toEqual(qualify({
      P: 95.5, B: 11.25, freeShipping: true, S: 14, removalMin: d.mpn.removal.minutes, packagingCost: 4.5,
      appliance: libraryAppliance(d.mpn.appliance_mode), sold90: 12, sellThroughPct: 42.5, strategicExceptionApproved: true
    }, s));
    // The pump has no exact sell-through from the provider: it needs data, it is not derived.
    expect((await mpnDetail(db, PUMP))!.mpn.qualification).toMatchObject({ result: "NEEDS_DATA", missing: expect.arrayContaining(["sell_through"]) });
  });

  it("14/15. harvest candidates and Roadrunner sales history are independent of a refresh", async () => {
    configure();
    await upsertSaleEvents(db, [{ mpnCanonical: BOARD, mpnDisplay: BOARD, sourceEventId: "o-1", soldAt: "2026-09-01", quantity: 2,
      itemPrice: 88, listedAt: "2026-08-20", daysToSell: null, daysToSellSource: null }]);
    const harvestBefore = (await mpnDetail(db, BOARD))!.harvest;
    const salesBefore = await db.select().from(schema.roadrunnerSaleEvents);
    const perfBefore = await roadrunnerPerformance(db, [BOARD]);

    provider(envelope([found(BOARD, sold90({ soldQty: 99, avgSoldPrice: 150, capturedAt: "2026-10-01T00:00:00Z" }), active({ activeQty: 1 }))]));
    expect((await refreshMarketFactsAction(null, form({ mpn: [BOARD] }))).ok).toBe(true);

    expect(await facts(BOARD)).toMatchObject({ sold90: 99, avgPrice: "150.00", activeQty: 1, researchedAt: "2026-10-01" });
    expect((await mpnDetail(db, BOARD))!.harvest).toEqual(harvestBefore);
    expect(await db.select().from(schema.roadrunnerSaleEvents)).toEqual(salesBefore);
    expect(await roadrunnerPerformance(db, [BOARD])).toEqual(perfBefore);
  });

  it("asking-basis 90-day prices never overwrite confirmed sold price/shipping; quantity, sell-through and freshness still update", async () => {
    configure();
    const mpn = "W22222222";
    await saveMarketAction(form({ mpn, sold90: "5", avgPrice: "64", avgShip: "8", sellThroughPct: "30", activeQty: "6", researchedAt: "2026-05-01" }));
    provider(envelope([found(mpn, sold90({ priceBasis: "asking", soldQty: 7, avgSoldPrice: 140, avgBuyerShipping: 19, sellThroughPct: 35 }),
      active({ activeQty: 9, askingPrice: 150, askingShipping: 20 }))]));
    expect((await refreshMarketFactsAction(null, form({ mpn: [mpn] })))).toMatchObject({ ok: true });
    expect(await facts(mpn)).toMatchObject({
      sold90: 7, avgPrice: "64.00", avgShip: "8.00", sellThroughPct: "35.00", sellThroughSource: "research",
      activeQty: 9, researchedAt: "2026-09-20", source: "ebaydecisions_api"
    });
  });

  it("unknown-basis 90-day prices on a new row leave price/shipping null, and active asking price is not substituted", async () => {
    configure();
    const mpn = "W33333333";
    provider(envelope([found(mpn, sold90({ priceBasis: "unknown", soldQty: 3, avgSoldPrice: 77, avgBuyerShipping: 6 }),
      active({ activeQty: 4, askingPrice: 99, askingShipping: 7 }))]));
    expect((await refreshMarketFactsAction(null, form({ mpn: [mpn] })))).toMatchObject({ ok: true });
    expect(await facts(mpn)).toMatchObject({
      sold90: 3, avgPrice: null, avgShip: null, sellThroughPct: "42.50", activeQty: 4, researchedAt: "2026-09-20", source: "ebaydecisions_api"
    });
  });
});

describe("planMarketFacts", () => {
  it("dates SOLD freshness from sold90.capturedAt even when the active snapshot is newer", () => {
    const facts = parseMarketFactsResponse(envelope([found(BOARD, sold90({ capturedAt: "2026-03-02T10:00:00+00:00" }), active({ capturedAt: "2026-10-05T00:00:00Z" }))]), [BOARD]);
    const plan = planMarketFacts([BOARD], facts);
    expect(plan.sold[0].researchedAt).toBe("2026-03-02");
    expect(plan.active).toEqual([{ mpnCanonical: BOARD, activeQty: 37 }]);
  });

  it("passes avg price/shipping through only for a sold price basis", () => {
    const keys = [BOARD, PUMP, LID];
    const facts = parseMarketFactsResponse(envelope([
      found(BOARD, sold90(), null),
      found(PUMP, sold90({ priceBasis: "asking" }), active()),
      found(LID, sold90({ priceBasis: "unknown" }), null)
    ]), keys);
    expect(planMarketFacts(keys, facts).sold.map(({ mpnCanonical, priceIsSold, avgPrice, avgShip, sold90: q }) => ({ mpnCanonical, priceIsSold, avgPrice, avgShip, q }))).toEqual([
      { mpnCanonical: BOARD, priceIsSold: true, avgPrice: 95.5, avgShip: 11.25, q: 12 },
      { mpnCanonical: PUMP, priceIsSold: false, avgPrice: null, avgShip: null, q: 12 },
      { mpnCanonical: LID, priceIsSold: false, avgPrice: null, avgShip: null, q: 12 }
    ]);
  });
});
