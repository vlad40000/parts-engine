import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb, hasDatabase } from "@/src/db";
import { settings as settingsTable } from "@/src/db/schema";
import { getSettings, hasEligibleModelDonor } from "@/src/db/queries";
import { readModelBom, supplierFetcher } from "@/src/lib/model-bom";
import { brandKey, isUnreadableModel, modelKey } from "@/src/lib/model-key";
import { lookupModelBom, type ChainResult } from "@/src/sources/chain";
import { BOM_SOURCE_IDS } from "@/src/sources/selection";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const Body = z.object({ brand: z.string().trim().min(1).max(100), model: z.string().trim().min(1).max(120),
  availability: z.string().trim().optional(), source: z.enum(BOM_SOURCE_IDS).default("auto") });

const summary = (result: ChainResult) => ({
  status: result.status, supplier: result.winner?.supplier ?? null, sourceUrl: result.winner?.sourceUrl ?? null,
  dropped: result.winner?.droppedRows ?? 0,
  attempts: result.attempts.map((a) => ({ supplier: a.supplier, status: a.status, warnings: a.warnings, ms: a.elapsedMs,
    completeness: a.completeness, catalogPages: a.catalogPages, catalogRows: a.catalogRows }))
});

/** Read-only source check, including on Vercel Preview. Never initializes settings or saves a BOM. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = Body.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success || isUnreadableModel(parsed.data.model)) return NextResponse.json({ error: "A readable brand/model and a valid source are required." }, { status: 400 });
  if (!hasDatabase()) return NextResponse.json({ error: "DATABASE_URL is not configured." }, { status: 503 });
  const { brand, model, availability, source } = parsed.data;
  const db = await getDb();
  const [settings] = await db.select({ donorAvailabilities: settingsTable.donorAvailabilities }).from(settingsTable).where(eq(settingsTable.id, 1));
  if (!settings || !(await hasEligibleModelDonor(db, brandKey(brand), modelKey(model), settings.donorAvailabilities, availability))) {
    return NextResponse.json({ error: "No eligible donor machine has this model in the selected status. Nothing was researched." }, { status: 409 });
  }
  const result = await lookupModelBom({ brand, model }, supplierFetcher, source);
  return NextResponse.json({ ...summary(result), readOnly: true, rows: result.winner?.rows.length ?? 0,
    mpns: result.winner?.rows.map((r) => r.mpnCanonical) ?? [] });
}

export async function POST(request: Request) {
  if (process.env.VERCEL_ENV === "preview") return NextResponse.json({ error: "Saving parts lists is disabled on Preview. Use production to run a lookup." }, { status: 403 });
  if (!hasDatabase()) return NextResponse.json({ error: "DATABASE_URL is not configured." }, { status: 503 });
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "brand, model and a valid source are required." }, { status: 400 });
  const { brand, model, availability, source } = parsed.data;
  if (isUnreadableModel(model)) return NextResponse.json({ error: "Model is unreadable; read the nameplate first." }, { status: 400 });

  const db = await getDb();
  const settings = await getSettings(db);
  if (!(await hasEligibleModelDonor(db, brandKey(brand), modelKey(model), settings.donorAvailabilities, availability))) {
    return NextResponse.json({ error: "No eligible donor machine has this model in the selected status. Nothing was researched." }, { status: 409 });
  }

  const started = Date.now();
  const { result, saved } = await readModelBom(db, { brand, model }, supplierFetcher, source);
  return NextResponse.json({
    ...summary(result),
    rows: saved.rows,
    newMpns: saved.newMpns,
    elapsedMs: Date.now() - started
  });
}
