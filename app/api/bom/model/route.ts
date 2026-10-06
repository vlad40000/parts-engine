import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb, hasDatabase } from "@/src/db";
import { saveModelBom } from "@/src/db/queries";
import { brandKey, isUnreadableModel, modelKey } from "@/src/lib/model-key";
import { lookupModelBom } from "@/src/sources/chain";
import { createFetcher } from "@/src/sources/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const Body = z.object({ brand: z.string().trim().min(1), model: z.string().trim().min(1) });

// One fetcher per server instance so the per-supplier politeness gate is shared
// by every model in a batch.
const fetcher = createFetcher({ concurrency: 2, minGapMs: 600, timeoutMs: 20_000 });

export async function POST(request: Request) {
  if (!hasDatabase()) return NextResponse.json({ error: "DATABASE_URL is not configured." }, { status: 503 });
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "brand and model are required." }, { status: 400 });
  const { brand, model } = parsed.data;
  if (isUnreadableModel(model)) return NextResponse.json({ error: "Model is unreadable; read the nameplate first." }, { status: 400 });

  const started = Date.now();
  const result = await lookupModelBom({ brand, model }, fetcher);
  const saved = await saveModelBom(await getDb(), {
    brandKey: brandKey(brand),
    modelKey: modelKey(model),
    brandDisplay: brand,
    modelDisplay: model,
    result
  });
  return NextResponse.json({
    status: result.status,
    supplier: result.winner?.supplier ?? null,
    sourceUrl: result.winner?.sourceUrl ?? null,
    rows: saved.rows,
    newMpns: saved.newMpns,
    dropped: result.winner?.droppedRows ?? 0,
    attempts: result.attempts.map((a) => ({ supplier: a.supplier, status: a.status, warnings: a.warnings, ms: a.elapsedMs })),
    elapsedMs: Date.now() - started
  });
}
