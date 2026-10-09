import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import * as schema from "@/src/db/schema";
import type { Db } from "@/src/db/types";
import { getSettings, saveModelBom, saveSettings, upsertFleet } from "@/src/db/queries";
import { parseCsvRows, toCsv } from "@/src/lib/csv";
import { mapFleetRows } from "@/src/lib/fleet-import";
import { canonicalizeMpn } from "@/src/lib/mpn";
import {
  EBAYDECISIONS_MAX_MPNS, EBAYDECISIONS_REGISTER_ROUTE, EBAYDECISIONS_RESEARCH_ROUTE, EBAYDECISIONS_RESEARCH_TIMEOUT_MS, EBAYDECISIONS_ROUTE,
  EBAYDECISIONS_TIMEOUT_MS, EbayDecisionsError, parseResearchResponse, registerMpns, registrationPayload, researchCounts, researchMpns, type RegistrationPart
} from "@/src/lib/ebaydecisions";
import type { ChainResult } from "@/src/sources/chain";
import type { SupplierRow } from "@/src/sources/types";
import { importMarketAction, refreshMarketFactsAction } from "@/app/actions";
import { GET as exportQueue } from "@/app/api/export/research-queue/route";

// Server actions and the export route run against this file's PGlite database.
const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/src/db", () => ({ getDb: async () => holder.db, hasDatabase: () => true }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const ROOT = path.join(__dirname, "..");
const URL_ = "https://ebd.example";
const KEY = "pe-test-integration-key-0123456789";
const CONFIG = { url: URL_, apiKey: KEY };
const CAPTURED = new Date(Date.now() - 86_400_000).toISOString();
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
const upload = (name: string, content: string) => {
  const f = new FormData();
  f.set("file", new File([content], name, { type: "text/csv" }));
  return f;
};

// EbayDecisions schemaVersion 1 fixtures.
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
 * Every request is recorded, whatever its route.
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

/** Every .ts/.tsx file under a repo directory, repo-relative. */
const sourceFiles = (dir: string): string[] =>
  readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sourceFiles(path.join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(dir, e.name)] : []);

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
  await saveSettings(db, { ...(await getSettings(db)), minimumSellThroughPct: 30, minimumProfitMarginPct: 25 });
});

afterEach(() => {
  delete process.env.EBAYDECISIONS_URL;
  delete process.env.EBAYDECISIONS_API_KEY;
  vi.unstubAllGlobals();
});

describe("Research queue workflow: manual CSV first, no active research call", () => {
  it("no server action, page, route or component reaches registration or targeted research", async () => {
    expect(Object.keys(await import("@/app/actions"))).not.toContain("researchQueueAction");
    const active = [...sourceFiles("app"), ...sourceFiles("src/components")];
    expect(active).toEqual(expect.arrayContaining([path.join("app", "actions.ts"), path.join("app", "mpns", "page.tsx")]));
    for (const file of active) {
      expect(readFileSync(path.join(ROOT, file), "utf8"), file).not.toMatch(
        /researchMpns|registerMpns|registrationPayload|researchCounts|EBAYDECISIONS_RESEARCH|EBAYDECISIONS_REGISTER|\/api\/integrations\/(research|parts\/register)|Research next/
      );
    }
  });

  it("the whole operator workflow (export → import the completed CSV → refresh) sends only the market-facts read", async () => {
    configure();
    const { calls, routes } = provider();
    const [header, ...rows] = parseCsvRows(await (await exportQueue()).text());
    expect(rows.length).toBeGreaterThan(EBAYDECISIONS_MAX_MPNS);
    const filled = rows.map((r) => r.map((cell, i) => (header[i] === "90 Day sales" ? "2" : cell)));
    const imported = await importMarketAction(null, upload("research-queue.csv", toCsv(header, filled)));
    expect(imported).toMatchObject({ ok: true, message: expect.stringContaining(`90-day research saved for ${rows.length} MPNs`) });

    const keys = rows.slice(0, EBAYDECISIONS_MAX_MPNS).map((r) => canonicalizeMpn(r[0]));
    expect((await refreshMarketFactsAction(null, form({ mpn: keys }))).ok).toBe(true);
    expect(routes()).toEqual(["facts"]);
    expect(calls[0].body).toEqual({ mpns: keys });
  });

  it("the stored-facts refresh is unchanged: one market-facts request for the whole page, no registration or research", async () => {
    configure();
    const keys = Array.from({ length: 30 }, (_, i) => pe(i + 20));
    const { calls, routes } = provider();
    expect((await refreshMarketFactsAction(null, form({ mpn: keys }))).ok).toBe(true);
    expect(routes()).toEqual(["facts"]);
    expect(calls[0].body).toEqual({ mpns: keys });
  });
});

describe("EbayDecisions registration and research client (A3 provider contract; dormant until official eBay API activation)", () => {
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

  it("research is one request of D1 keys with a bounded timeout that fits a 300 s function budget", async () => {
    const { calls } = provider({}, ["W10006355"]);
    const results = await researchMpns(CONFIG, ["w1000-6355", "W10006355", "W99999999", "--"]);
    expect(calls.map((c) => c.body)).toEqual([{ mpns: ["W10006355", "W99999999"] }]);
    expect(results.map((r) => [r.mpnKey, r.registration, r.overall])).toEqual([["W10006355", "registered", "success"], ["W99999999", "unregistered", "failed"]]);
    expect(EBAYDECISIONS_RESEARCH_TIMEOUT_MS + 2 * EBAYDECISIONS_TIMEOUT_MS).toBeLessThan(300_000);
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

  it("validates research outcomes in full and counts them accurately", () => {
    const keys = [60, 61, 62, 63, 64, 65, 66].map(pe);
    const [k60, k61, k62, k63, k64, k65, k66] = keys;
    const results = [
      outcome(k60, "saved", "saved"),
      outcome(k61, "unverified", "saved", [NOTE.soldUnverified]),
      outcome(k62, "unavailable", "saved", [NOTE.soldUnavailable]),
      outcome(k63, "saved", "failed", [NOTE.active500]),
      outcome(k64, "failed", "failed", [NOTE.active500, NOTE.sold429]),
      outcome(k65, "unverified", "unavailable", [NOTE.activeUnavailable, NOTE.soldUnverified]),
      unregisteredOutcome(k66)
    ];
    expect(() => parseResearchResponse(resultsEnvelope([{ ...results[0], overall: "partial" }, ...results.slice(1)]), keys)).toThrow(EbayDecisionsError);
    expect(() => parseResearchResponse(resultsEnvelope(results.slice(1)), keys)).toThrow(EbayDecisionsError);
    const registration = keys.map((mpnKey, i) => ({ mpnKey, mpnDisplay: mpnKey, status: i < 2 ? "existing" as const : "inserted" as const }));
    expect(researchCounts(registration, parseResearchResponse(resultsEnvelope(results), keys))).toEqual({
      inserted: 5, existing: 2, soldSaved: 2, activeSaved: 3, soldUnavailable: 1, soldUnverified: 2, failed: 3, unregistered: 1,
      notes: [
        { note: NOTE.soldUnverified, count: 2 },
        { note: NOTE.soldUnavailable, count: 1 },
        { note: NOTE.active500, count: 2 },
        { note: NOTE.sold429, count: 1 },
        { note: NOTE.activeUnavailable, count: 1 },
        { note: NOTE.unregistered, count: 1 }
      ]
    });
  });
});
