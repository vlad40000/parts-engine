import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb, hasDatabase } from "@/src/db";
import { getSettings, hasEligibleModelDonor } from "@/src/db/queries";
import { readModelBom } from "@/src/lib/model-bom";
import { brandKey, isUnreadableModel, modelKey } from "@/src/lib/model-key";
import { lgIdentity, lgVariation } from "@/src/lib/lg-variation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const Body = z.object({ brand: z.string().trim().min(1), model: z.string().trim().min(1), variation: z.string().trim().optional().nullable(), availability: z.string().trim().optional() });

export async function POST(request: Request) {
  if (!hasDatabase()) return NextResponse.json({ error: "DATABASE_URL is not configured." }, { status: 503 });
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "brand and model are required." }, { status: 400 });
  const { brand, model, variation, availability } = parsed.data;
  if (isUnreadableModel(model)) return NextResponse.json({ error: "Model is unreadable; read the nameplate first." }, { status: 400 });

  if (brandKey(brand) === "LG" && (!lgVariation(variation) || model.includes("/"))) {
    return NextResponse.json({ error: "VERIFY VARIATION: enter an exact LG manufacturer variation and verify any /00-style revision separately before researching." }, { status: 409 });
  }
  const db = await getDb();
  const settings = await getSettings(db);
  if (!(await hasEligibleModelDonor(db, brandKey(brand), brandKey(brand) === "LG" ? lgIdentity(brand, model, variation).modelKey : modelKey(model), settings.donorAvailabilities, availability))) {
    return NextResponse.json({ error: "No eligible donor machine has this model in the selected status. Nothing was researched." }, { status: 409 });
  }

  const started = Date.now();
  const { result, saved } = await readModelBom(db, { brand, model, variation });
  return NextResponse.json({
    status: result.status,
    supplier: result.winner?.supplier ?? null,
    sourceUrl: result.winner?.sourceUrl ?? null,
    rows: saved.rows,
    newMpns: saved.newMpns,
    dropped: result.winner?.droppedRows ?? 0,
    kept: saved.kept ? { rows: saved.kept.rowCount, fetchedAt: saved.kept.fetchedAt.toISOString() } : null,
    attempts: result.attempts.map((a) => ({ supplier: a.supplier, status: a.status, warnings: a.warnings, ms: a.elapsedMs })),
    elapsedMs: Date.now() - started
  });
}
