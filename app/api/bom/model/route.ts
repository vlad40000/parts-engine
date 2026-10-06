import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb, hasDatabase } from "@/src/db";
import { readModelBom } from "@/src/lib/model-bom";
import { isUnreadableModel } from "@/src/lib/model-key";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const Body = z.object({ brand: z.string().trim().min(1), model: z.string().trim().min(1) });

export async function POST(request: Request) {
  if (!hasDatabase()) return NextResponse.json({ error: "DATABASE_URL is not configured." }, { status: 503 });
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "brand and model are required." }, { status: 400 });
  const { brand, model } = parsed.data;
  if (isUnreadableModel(model)) return NextResponse.json({ error: "Model is unreadable; read the nameplate first." }, { status: 400 });

  const started = Date.now();
  const { result, saved } = await readModelBom(await getDb(), { brand, model });
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
