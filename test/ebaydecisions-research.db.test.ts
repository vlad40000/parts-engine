import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as schema from "@/src/db/schema";
import type { Db } from "@/src/db/types";
import { getSettings, mpnDetail, mpnIndex, saveModelBom, saveSettings, upsertFleet } from "@/src/db/queries";
import { mapFleetRows } from "@/src/lib/fleet-import";
import { canonicalizeMpn } from "@/src/lib/mpn";
import {
  EBAYDECISIONS_REGISTER_ROUTE, EBAYDECISIONS_RESEARCH_MAX_MPNS, EBAYDECISIONS_RESEARCH_ROUTE, EBAYDECISIONS_RESEARCH_TIMEOUT_MS, EBAYDECISIONS_ROUTE,
  EBAYDECISIONS_TIMEOUT_MS, EbayDecisionsError, registerMpns, registrationPayload, researchMpns, type RegistrationPart
} from "@/src/lib/ebaydecisions";
import type { ChainResult } from "@/src/sources/chain";
import type { SupplierRow } from "@/src/sources/types";
import { importMarketAction, refreshMarketFactsAction, researchQueueAction, saveMarketAction, saveMpnManualAction } from "@/app/actions";

// Server actions run against this file's PGlite database.
const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/src/db", () => ({ getDb: async () => holder.db, hasDatabase: () => true }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const ROOT = path.join(__dirname, "..");
const URL_ = "https://ebd.example";
const KEY = "pe-test-integration-key-0123456789";
const CONFIG = { url: URL_, apiKey: KEY };
const CAPTURED = new Date(Date.now() - 86_400_000).toISOString();
const CAPTURED_DAY = CAPTURED.slice(0, 10);
const GENERATED = "2026-10-07T12:00:00.000Z";
const LONG = "Drain Pump ".repeat(60).trim();
let db: Db;

const pe = (i: number) => `PE${String(i).padStart(3, "0")}`;
const part = (mpnDisplay: string, description: string): SupplierRow => ({
  mpnDisplay, mpnCanonical: canonicalizeMpn(mpnDisplay), description, diagramId: "1", supplierPartId: null, newPrice: 60, nla: false
});
const chain = (rows: SupplierRow[]): ChainResult => ({
  status: "found",
  winner: { supplier: "encompass", status: "found", rows, droppedRows: 0, sourceUrl: "https://x", visited: [], warnings: [], elapsedMs: 1 },
  attempts: [{ supplier: "encompass", status: "found", droppedRows: 0, sourceUrl: "https://x", visited: [], warnings: [], elapsedMs: 1 }]
});
const machine = (id: number, type: string, model: string) =>
  ({ ID: id, Availability: "UNCHECKED", ApplianceType: type, Brand: "Maytag", ModelNumber: model, SerialNumber: "" });
const form = (fields: Record<string, string | string[]>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const x of [v].flat()) f.append(k, x);
  return f;
};
const allFacts = async () => (await db.select().from(schema.marketFacts)).sort((a, b) => a.mpnCanonical.localeCompare(b.mpnCanonical));
const facts = async (mpn: string) => (await allFacts()).find((r) => r.mpnCanonical === mpn);

// EbayDecisions schemaVersion 1 fixtures. Official research never supplies exact sell-through.
const sold90 = (p: Record<string, unknown> = {}) => ({
  soldQty: 12, avgSoldPrice: 95.5, avgBuyerShipping: 11.25, sellThroughPct: null, source: "ebay_insights", priceBasis: "sold", capturedAt: CAPTURED, ...p
});
const active = (p: Record<string, unknown> = {}) => ({
  activeQty: 37, askingPrice: 120, askingShipping: 9.5, source: "ebay_browse", sampleSize: 37, truncated: false, capturedAt: CAPTURED, ...p
});
const found = (mpnKey: string, s: unknown, a: unknown) => ({ mpnKey, mpnDisplay: mpnKey, status: "found", sold90: s, active: a });
const unregisteredFact = (mpnKey: string) => ({ mpnKey, mpnDisplay: null, status: "unregistered", sold90: null, active: null });
const factsEnvelope = (list: unknown[]) => ({ schemaVersion: 1, generatedAt: GENERATED, facts: list });
const resultsEnvelope = (results: unknown[]) => ({ schemaVersion: 1, generatedAt: GENERATED, results });

// The provider's fixed notes (EbayDecisions src/lib/ebay/exact-mpn-research.ts).
const NOTE = {
  soldUnverified: "Sold: exact-MPN verification was not possible (a returned sale had no title, or none were returned); nothing saved.",
  soldUnavailable: "Sold: these eBay credentials have no Marketplace Insights access; nothing saved.",
  activeUnavailable: "Active: these eBay credentials have no Browse access; nothing saved.",
  active500: "Active: eBay answered HTTP 500; nothing saved.",
  sold429: "Sold: eBay answered HTTP 429; nothing saved.",
  unregistered: "Not registered. Register the MPN first; research never registers parts."
};
const outcome = (mpnKey: string, sold: string, act: string, notes: string[] = []) => {
  const saved = (sold === "saved" ? 1 : 0) + (act === "saved" ? 1 : 0);
  return { mpnKey, mpnDisplay: mpnKey, registration: "registered", sold, active: act, overall: saved === 2 ? "success" : saved ? "partial" : "failed", notes };
};
const unregisteredOutcome = (mpnKey: string) =>
  ({ mpnKey, mpnDisplay: null, registration: "unregistered", sold: null, active: null, overall: "failed", notes: [NOTE.unregistered] });

type Route = "register" | "research" | "facts";
type Body = { parts?: RegistrationPart[]; mpns?: string[] };
type Handler = (body: Body) => unknown;
const ROUTES: Record<string, Route> = { [EBAYDECISIONS_REGISTER_ROUTE]: "register", [EBAYDECISIONS_RESEARCH_ROUTE]: "research", [EBAYDECISIONS_ROUTE]: "facts" };
const reply = (status: number, body: unknown) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * A stateful fake of the EbayDecisions A3 provider on its real routes: registration is insert-only,
 * research saves only registered keys, and market facts return what research saved. Any route can be overridden.
 */
function provider(over: Partial<Record<Route, Handler>> = {}, preRegistered: string[] = []) {
  const calls: Array<{ route: Route; body: Body; init: RequestInit }> = [];
  const registered = new Set(preRegistered);
  const researched = new Set<string>();
  const handlers: Record<Route, Handler> = {
    register: (b) => resultsEnvelope(b.parts!.map((p) => {
      const mpnKey = canonicalizeMpn(p.mpn);
      const status = registered.has(mpnKey) ? "existing" : "inserted";
      registered.add(mpnKey);
      return { mpnKey, mpnDisplay: p.mpn, status };
    })),
    research: (b) => resultsEnvelope(b.mpns!.map((k) => (registered.has(k) ? (researched.add(k), outcome(k, "saved", "saved")) : unregisteredOutcome(k)))),
    facts: (b) => factsEnvelope(b.mpns!.map((k) => (researched.has(k) ? found(k, sold90(), active()) : registered.has(k) ? found(k, null, null) : unregisteredFact(k)))),
    ...over
  };
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const route = ROUTES[new URL(String(url)).pathname];
    const body = JSON.parse(String(init?.body)) as Body;
    calls.push({ route, body, init: init! });
    if (!route) return reply(404, { error: "Not found." });
    const out = handlers[route](body);
    return out instanceof Response ? out : reply(200, out);
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls, routes: () => calls.map((c) => c.route) };
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
  // Two washer donors hold 105 parts; three dryer donors hold one, so the dryer part leads the queue.
  await upsertFleet(db, mapFleetRows([
    machine(1, "Washer - Top Load", "MVWX655DW1"), machine(2, "Washer - Top Load", "MVWX655DW1"),
    machine(3, "Dryer - Electric", "MEDX655DW1"), machine(4, "Dryer - Electric", "MEDX655DW1"), machine(5, "Dryer - Electric", "MEDX655DW1")
  ]).rows);
  await saveModelBom(db, {
    brandKey: "MAYTAG", modelKey: "MVWX655DW1", brandDisplay: "Maytag", modelDisplay: "MVWX655DW1",
    result: chain(Array.from({ length: 105 }, (_, i) =>
      i === 0 ? part("PE-000", "Drain Pump 0") : i === 1 ? part(pe(1), "") : i === 2 ? part(pe(2), LONG) : part(pe(i), `Drain Pump ${i}`)))
  });
  await saveModelBom(db, {
    brandKey: "MAYTAG", modelKey: "MEDX655DW1", brandDisplay: "Maytag", modelDisplay: "MEDX655DW1", result: chain([part("DR-500", "Dryer Belt")])
  });
  // Rules set, so a part without exact sell-through answers NEEDS DATA rather than SET RULE.
  await saveSettings(db, { ...(await getSettings(db)), minimumSellThroughPct: 30, minimumProfitMarginPct: 25 });
});

afterEach(() => {
  delete process.env.EBAYDECISIONS_URL;
  delete process.env.EBAYDECISIONS_API_KEY;
  vi.unstubAllGlobals();
});

describe("One-click research (A4)", () => {
  it("without integration config nothing is sent, and the CSV fallback still imports", async () => {
    const { fn } = provider();
    expect(await researchQueueAction(null, form({ mpn: [pe(90)] }))).toMatchObject({ ok: false, message: expect.stringContaining("not configured") });
    expect(fn).not.toHaveBeenCalled();

    const upload = new FormData();
    upload.set("file", new File([`mpn,sold90,avg_price,avg_ship,sell_through_pct,active_qty,researched_at\n${pe(90)},4,70,9,25,8,2026-08-01`], "m.csv", { type: "text/csv" }));
    expect(await importMarketAction(null, upload)).toMatchObject({ ok: true });
    expect(await facts(pe(90))).toMatchObject({ sold90: 4, sellThroughPct: "25.00", source: "market_import" });
  });

  it("one click: register → research → market facts, for the first 20 of 100 rendered queue MPNs in donor order, sending MPN + description only", async () => {
    configure();
    const { rows } = await mpnIndex(db, { view: "queue" }, 100, 0);
    expect(rows).toHaveLength(100);
    const first20 = rows.slice(0, EBAYDECISIONS_RESEARCH_MAX_MPNS).map((r) => r.mpn_canonical);
    expect(first20).toEqual(["DR500", ...Array.from({ length: 19 }, (_, i) => pe(i))]);

    const { calls, routes } = provider();
    const res = await researchQueueAction(null, form({ mpn: rows.map((r) => r.mpn_canonical) }));

    expect(routes()).toEqual(["register", "research", "facts"]);
    for (const c of calls) {
      expect(c.init.method).toBe("POST");
      expect((c.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
      expect(c.init.signal).toBeInstanceOf(AbortSignal);
    }
    // Registration: display MPN and description, nothing else.
    const [register, research, refresh] = calls.map((c) => c.body);
    expect(Object.keys(register)).toEqual(["parts"]);
    expect(register.parts).toHaveLength(20);
    for (const p of register.parts!) expect(Object.keys(p).sort()).toEqual(["description", "mpn"]);
    expect(register.parts!.slice(0, 3)).toEqual([
      { mpn: "DR-500", description: "Dryer Belt" },
      { mpn: "PE-000", description: "Drain Pump 0" },
      { mpn: pe(1), description: null }
    ]);
    expect(register.parts![3]).toEqual({ mpn: pe(2), description: LONG.slice(0, 500).trim() });
    expect(register.parts!.map((p) => canonicalizeMpn(p.mpn))).toEqual(first20);
    // Research and the stored-facts read: D1 keys only.
    expect(research).toEqual({ mpns: first20 });
    expect(refresh).toEqual({ mpns: first20 });
    expect(JSON.stringify(calls.map((c) => c.body))).not.toMatch(/donor|qty|quantity|stock|inventory|price|cost|margin|economic|machine|serial|model|fleet/i);

    expect(res).toEqual({
      ok: true,
      message: "Researched 20 MPNs with EbayDecisions; market facts refreshed for 20 of 20.",
      details: [
        "Registered: 20 new, 0 already in EbayDecisions (MPN and description only).",
        "Sold research saved: 20. Active research saved: 20.",
        "Sold not saved: 0 unavailable (no Marketplace Insights access), 0 unverified (exact MPN not confirmed).",
        "Failed (nothing saved): 0.",
        "Market facts refreshed: 20 of 20 (90-day sold facts saved in Parts Engine).",
        "Exact sell-through still missing for 20 of 20. It is never derived, so these stay NEEDS DATA until EbayDecisions stores an exact value.",
        "Qualification now: 0 qualified, 20 needs data, 0 not qualified, 0 set rule, 0 without market facts."
      ]
    });
    expect(await facts("DR500")).toMatchObject({
      sold90: 12, avgPrice: "95.50", avgShip: "11.25", sellThroughPct: null, sellThroughSource: null, activeQty: 37, researchedAt: CAPTURED_DAY, source: "ebaydecisions_api"
    });
    expect((await mpnDetail(db, "DR500"))!.mpn.qualification).toMatchObject({ result: "NEEDS_DATA", missing: expect.arrayContaining(["sell_through"]) });
    // Nothing past the 20th rendered row was touched.
    expect(await facts(pe(19))).toBeUndefined();
    expect((await mpnIndex(db, { view: "queue" }, 100, 0)).rows[0].mpn_canonical).toBe(pe(19));
  });

  it("writes only the A2 provider-owned fields: exact sell-through only when EbayDecisions stores one, and asking prices never replace sold prices", async () => {
    configure();
    await saveMarketAction(form({ mpn: pe(50), sold90: "2", avgPrice: "80", avgShip: "10", sellThroughPct: "", activeQty: "5",
      qtyOnHand: "3", researchedAt: "2026-06-01", freeShipping: "on", shipCost: "14" }));
    await saveMpnManualAction(form({ mpn: pe(50), removalMin: "22", packagingCost: "4.50", strategicExceptionApproved: "on" }));
    await saveMarketAction(form({ mpn: pe(52), sold90: "5", avgPrice: "64", avgShip: "8", sellThroughPct: "", activeQty: "6", researchedAt: "2026-05-01" }));

    provider({
      facts: () => factsEnvelope([
        found(pe(50), sold90({ soldQty: 7, avgSoldPrice: 90, avgBuyerShipping: 10 }), active({ activeQty: 41 })),
        found(pe(51), sold90({ sellThroughPct: 31.5 }), active()),
        found(pe(52), sold90({ priceBasis: "asking", soldQty: 9, avgSoldPrice: 140, avgBuyerShipping: 19 }), active({ activeQty: 9, askingPrice: 150 }))
      ])
    });
    const res = await researchQueueAction(null, form({ mpn: [pe(50), pe(51), pe(52)] }));
    expect(res.ok).toBe(true);

    // Provider-owned fields move; free shipping, ship cost and qty on hand stay local.
    expect(await facts(pe(50))).toMatchObject({
      sold90: 7, avgPrice: "90.00", avgShip: "10.00", sellThroughPct: null, sellThroughSource: null, activeQty: 41,
      researchedAt: CAPTURED_DAY, source: "ebaydecisions_api", freeShipping: true, shipCost: "14.00", qtyOnHand: 3
    });
    const d50 = (await mpnDetail(db, pe(50)))!.mpn;
    expect({ removal: d50.removal_min, packaging: d50.packaging_cost, exception: d50.strategic_exception_approved }).toEqual({ removal: "22.0", packaging: "4.50", exception: true });
    // Exact sell-through is stored only because EbayDecisions returned a stored exact value.
    expect(await facts(pe(51))).toMatchObject({ sellThroughPct: "31.50", sellThroughSource: "research" });
    // Asking-basis prices keep the confirmed sold price/shipping; quantity and freshness still update.
    expect(await facts(pe(52))).toMatchObject({ sold90: 9, avgPrice: "64.00", avgShip: "8.00", sellThroughPct: null, activeQty: 9, researchedAt: CAPTURED_DAY });

    expect(res.details).toContain("Exact sell-through still missing for 2 of 3. It is never derived, so these stay NEEDS DATA until EbayDecisions stores an exact value.");
    for (const k of [pe(50), pe(52)]) {
      expect((await mpnDetail(db, k))!.mpn.qualification).toMatchObject({ result: "NEEDS_DATA", missing: expect.arrayContaining(["sell_through"]) });
    }
    const q51 = (await mpnDetail(db, pe(51)))!.mpn.qualification!;
    expect(q51.result === "NEEDS_DATA" ? q51.missing : []).not.toContain("sell_through");
  });

  it("reports partial research accurately", async () => {
    configure();
    const keys = [60, 61, 62, 63, 64, 65, 66].map(pe);
    const [k60, k61, k62, k63, k64, k65, k66] = keys;
    const { routes } = provider({
      research: () => resultsEnvelope([
        outcome(k60, "saved", "saved"),
        outcome(k61, "unverified", "saved", [NOTE.soldUnverified]),
        outcome(k62, "unavailable", "saved", [NOTE.soldUnavailable]),
        outcome(k63, "saved", "failed", [NOTE.active500]),
        outcome(k64, "failed", "failed", [NOTE.active500, NOTE.sold429]),
        outcome(k65, "unverified", "unavailable", [NOTE.activeUnavailable, NOTE.soldUnverified]),
        unregisteredOutcome(k66)
      ]),
      facts: () => factsEnvelope([
        found(k60, sold90(), active()), found(k61, null, active()), found(k62, null, active()), found(k63, sold90(), null),
        found(k64, null, null), found(k65, null, null), unregisteredFact(k66)
      ])
    }, [k60, k61]);

    const res = await researchQueueAction(null, form({ mpn: keys }));
    expect(routes()).toEqual(["register", "research", "facts"]);
    expect(res).toEqual({
      ok: true,
      message: "Researched 7 MPNs with EbayDecisions; market facts refreshed for 2 of 7.",
      details: [
        "Registered: 5 new, 2 already in EbayDecisions (MPN and description only).",
        "Sold research saved: 2. Active research saved: 3.",
        "Sold not saved: 1 unavailable (no Marketplace Insights access), 2 unverified (exact MPN not confirmed).",
        "Failed (nothing saved): 3, 1 of them not registered.",
        `EbayDecisions note (2 MPNs): ${NOTE.soldUnverified}`,
        `EbayDecisions note (1 MPN): ${NOTE.soldUnavailable}`,
        `EbayDecisions note (2 MPNs): ${NOTE.active500}`,
        `EbayDecisions note (1 MPN): ${NOTE.sold429}`,
        `EbayDecisions note (1 MPN): ${NOTE.activeUnavailable}`,
        `EbayDecisions note (1 MPN): ${NOTE.unregistered}`,
        "Market facts refreshed: 2 of 7 (90-day sold facts saved in Parts Engine).",
        "No 90-day sold research stored yet: 4 (sold facts and research date left as they were).",
        "Not registered in EbayDecisions: 1 (existing facts kept).",
        "Exact sell-through still missing for 7 of 7. It is never derived, so these stay NEEDS DATA until EbayDecisions stores an exact value.",
        "Qualification now: 0 qualified, 2 needs data, 0 not qualified, 0 set rule, 5 without market facts."
      ]
    });
    expect(await facts(k61)).toMatchObject({ activeQty: 37, sold90: null, researchedAt: null });
    expect(await facts(k64)).toBeUndefined();
    expect(await facts(k66)).toBeUndefined();
  });

  it("a failed or malformed registration stops before research and saves nothing", async () => {
    configure();
    await saveMarketAction(form({ mpn: pe(70), sold90: "3", avgPrice: "40", avgShip: "6", sellThroughPct: "22", activeQty: "2", researchedAt: "2026-04-01" }));
    const before = await allFacts();
    const ok = (k: string) => ({ mpnKey: k, mpnDisplay: k, status: "inserted" });
    const cases: unknown[] = [
      reply(401, { error: "Unauthorized." }),
      reply(503, { error: "The integration API is not configured." }),
      reply(500, { error: "Registration failed." }),
      reply(200, "<html>not json</html>"),
      { ...resultsEnvelope([ok(pe(70)), ok(pe(71))]), schemaVersion: 2 },
      resultsEnvelope([ok(pe(70)), { ...ok(pe(71)), status: "updated" }]),
      resultsEnvelope([ok(pe(70))]),
      resultsEnvelope([ok(pe(70)), ok(pe(71)), ok("W00000000")]),
      resultsEnvelope([ok(pe(70)), ok(pe(70))]),
      resultsEnvelope([ok(pe(70)), ok("pe071")])
    ];
    for (const answer of cases) {
      const { routes } = provider({ register: () => answer });
      const res = await researchQueueAction(null, form({ mpn: [pe(70), pe(71)] }));
      expect(routes(), JSON.stringify(answer)).toEqual(["register"]);
      expect(res.ok).toBe(false);
      expect(res.message).toContain("Nothing was researched or saved.");
      expect(JSON.stringify(res)).not.toContain(KEY);
    }
    expect(await allFacts()).toEqual(before);
  });

  it("a failed or malformed research call still ends in the validated stored-facts read; unregistered MPNs keep their facts", async () => {
    configure();
    await saveMarketAction(form({ mpn: pe(72), sold90: "5", avgPrice: "50", avgShip: "7", sellThroughPct: "20", activeQty: "3", researchedAt: "2026-05-01" }));
    const kept = await facts(pe(72));
    const cases: unknown[] = [
      reply(500, { error: "Research failed." }),
      reply(503, { error: "eBay API credentials are not configured." }),
      reply(504, "gateway timeout"),
      { ...resultsEnvelope([outcome(pe(72), "saved", "saved"), outcome(pe(73), "saved", "saved")]), schemaVersion: 2 },
      resultsEnvelope([{ ...outcome(pe(72), "saved", "saved"), overall: "partial" }, outcome(pe(73), "saved", "saved")]),
      resultsEnvelope([{ ...outcome(pe(72), "saved", "saved"), sold: null }, outcome(pe(73), "saved", "saved")]),
      resultsEnvelope([{ ...unregisteredOutcome(pe(72)), sold: "saved", overall: "partial" }, outcome(pe(73), "saved", "saved")]),
      resultsEnvelope([outcome(pe(73), "saved", "saved")]),
      resultsEnvelope([outcome(pe(72), "saved", "saved"), outcome(pe(73), "saved", "saved"), outcome("W00000000", "saved", "saved")])
    ];
    for (const answer of cases) {
      const { routes } = provider({
        research: () => answer,
        // The provider saved PE073 before stopping; PE072 is not registered there.
        facts: () => factsEnvelope([unregisteredFact(pe(72)), found(pe(73), sold90({ soldQty: 4 }), active({ activeQty: 6 }))])
      });
      const res = await researchQueueAction(null, form({ mpn: [pe(72), pe(73)] }));
      expect(routes(), JSON.stringify(answer)).toEqual(["register", "research", "facts"]);
      expect(res.ok).toBe(false);
      expect(res.message).toBe("Research did not complete; stored facts were still refreshed for 1 of 2 MPNs.");
      expect(res.details!.some((d) => d.startsWith("Research: ") && d.endsWith("No research outcome was read."))).toBe(true);
      expect(JSON.stringify(res)).not.toContain(KEY);
      expect(await facts(pe(72))).toEqual(kept);
      expect(await facts(pe(73))).toMatchObject({ sold90: 4, activeQty: 6, sellThroughPct: null, source: "ebaydecisions_api" });
    }
  });

  it("a failed stored-facts read saves nothing and still reports what research did", async () => {
    configure();
    const before = await allFacts();
    const { routes } = provider({ facts: () => reply(401, { error: "Unauthorized." }) });
    const res = await researchQueueAction(null, form({ mpn: [pe(74)] }));
    expect(routes()).toEqual(["register", "research", "facts"]);
    expect(res).toMatchObject({ ok: false, message: "Market facts were not refreshed; nothing was saved in Parts Engine." });
    expect(res.details).toEqual(expect.arrayContaining([
      "Registered: 1 new, 0 already in EbayDecisions (MPN and description only).",
      "Sold research saved: 1. Active research saved: 1.",
      "EbayDecisions rejected the integration key (401). Nothing was saved."
    ]));
    expect(await allFacts()).toEqual(before);
  });

  it("sends only MPNs in Parts Engine's own index", async () => {
    configure();
    const { calls } = provider();
    const res = await researchQueueAction(null, form({ mpn: ["ZZ-999", pe(80)] }));
    expect(calls[0].body).toEqual({ parts: [{ mpn: pe(80), description: "Drain Pump 80" }] });
    expect(calls[1].body).toEqual({ mpns: [pe(80)] });
    expect(res.details![0]).toBe("Not in the MPN index, not sent: 1.");

    const none = provider();
    expect(await researchQueueAction(null, form({ mpn: ["ZZ-999"] }))).toMatchObject({ ok: false });
    expect(none.fn).not.toHaveBeenCalled();
  });

  it("the existing stored-facts refresh is unchanged: one market-facts request for the whole page, no registration or research", async () => {
    configure();
    const keys = Array.from({ length: 30 }, (_, i) => pe(i + 20));
    const { calls, routes } = provider();
    expect((await refreshMarketFactsAction(null, form({ mpn: keys }))).ok).toBe(true);
    expect(routes()).toEqual(["facts"]);
    expect(calls[0].body).toEqual({ mpns: keys });
  });
});

describe("EbayDecisions registration and research client (A3 provider contract)", () => {
  it("registration payload is the display MPN and description only, within the provider's bounds", () => {
    expect(registrationPayload([
      { mpnCanonical: "DC4700019A", mpnDisplay: " DC47-00019A ", description: " Thermal fuse " },
      { mpnCanonical: "W10006355", mpnDisplay: "W10006356", description: "" },
      { mpnCanonical: "X1", mpnDisplay: "X-1" + "-".repeat(200), description: "d".repeat(600) }
    ])).toEqual([
      { mpn: "DC47-00019A", description: "Thermal fuse" },
      // A display that would register a different D1 key falls back to the key itself.
      { mpn: "W10006355", description: null },
      { mpn: "X1", description: "d".repeat(500) }
    ]);
  });

  it("rebuilds the request so no other field can be sent, and refuses more than 20 MPNs without calling", async () => {
    const { calls, fn } = provider();
    const smuggled = { mpn: "X1", description: "d", donors: 4, qtyOnHand: 2, machineNo: "M1" } as unknown as RegistrationPart;
    await registerMpns(CONFIG, [smuggled]);
    expect(calls[0].body).toEqual({ parts: [{ mpn: "X1", description: "d" }] });

    fn.mockClear();
    const many = Array.from({ length: 21 }, (_, i) => `X${i}`);
    await expect(registerMpns(CONFIG, many.map((mpn) => ({ mpn, description: null })))).rejects.toThrow("At most 20");
    await expect(researchMpns(CONFIG, many)).rejects.toThrow("At most 20");
    await expect(registerMpns(CONFIG, [{ mpn: "X-1", description: null }, { mpn: "x1", description: null }])).rejects.toThrow(EbayDecisionsError);
    expect(fn).not.toHaveBeenCalled();
  });

  it("research is one request of D1 keys with a bounded timeout that fits the page's 300 s budget", async () => {
    const { calls } = provider({}, ["W10006355"]);
    const results = await researchMpns(CONFIG, ["w1000-6355", "W10006355", "W99999999", "--"]);
    expect(calls.map((c) => c.body)).toEqual([{ mpns: ["W10006355", "W99999999"] }]);
    expect(results.map((r) => [r.mpnKey, r.registration, r.overall])).toEqual([["W10006355", "registered", "success"], ["W99999999", "unregistered", "failed"]]);
    expect(EBAYDECISIONS_RESEARCH_TIMEOUT_MS + 2 * EBAYDECISIONS_TIMEOUT_MS).toBeLessThan(300_000);
    expect(readFileSync(path.join(ROOT, "app/mpns/page.tsx"), "utf8")).toMatch(/export const maxDuration = 300;/);
  });

  it("times out instead of hanging, with our own words only", async () => {
    const hang = vi.fn((_u: unknown, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    })) as unknown as typeof fetch;
    await expect(researchMpns(CONFIG, ["W1"], { fetchImpl: hang, timeoutMs: 20 })).rejects.toThrow("Research: EbayDecisions did not answer in time.");
    await expect(registerMpns(CONFIG, [{ mpn: "W1", description: null }], { fetchImpl: hang, timeoutMs: 20 }))
      .rejects.toThrow("Registration: EbayDecisions did not answer in time.");
  });

  it("drops any provider note that would echo the integration key", async () => {
    provider({ research: (b) => resultsEnvelope(b.mpns!.map((k) => outcome(k, "saved", "saved", [`leak ${KEY}`, NOTE.active500]))) });
    const [result] = await researchMpns(CONFIG, ["W1"]);
    expect(result.notes).toEqual([NOTE.active500]);
  });
});
