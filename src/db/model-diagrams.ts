import { and, eq, ne } from "drizzle-orm";
import { brandKey } from "@/src/lib/model-key";
import { exactDiagramModel, type ModelDiagrams } from "@/src/lib/model-diagrams";
import { modelDiagrams } from "./schema";
import type { Db } from "./types";

type DiagramModel = { brand: string; modelRaw: string };

function diagramKey(model: DiagramModel) {
  return { brandKey: brandKey(model.brand), exactModel: exactDiagramModel(model.modelRaw) };
}

export function isDiagramTableMissing(error: unknown): boolean {
  const seen = new Set<unknown>();
  while (error && typeof error === "object" && !seen.has(error)) {
    seen.add(error);
    const pg = error as { code?: string; message?: string; cause?: unknown };
    if (pg.code === "42P01" && pg.message?.includes('"model_diagrams"')) return true;
    error = pg.cause;
  }
  return false;
}

/** Null means no workbook. Undefined means the additive migration is pending. */
export async function getModelDiagrams(db: Db, model: DiagramModel) {
  const key = diagramKey(model);
  try {
    const [entry] = await db.select().from(modelDiagrams).where(and(
      eq(modelDiagrams.brandKey, key.brandKey), eq(modelDiagrams.exactModel, key.exactModel)
    ));
    return entry ?? null;
  } catch (error) {
    if (isDiagramTableMissing(error)) return undefined;
    throw error;
  }
}

export async function saveModelDiagrams(
  db: Db, model: DiagramModel, workbook: ModelDiagrams & { sourceSha256: string }, expectedSha256: string
) {
  const { sourceSha256, ...evidence } = workbook;
  const row = { sourceSha256, evidence };
  const [saved] = await db.insert(modelDiagrams).values({ ...diagramKey(model), ...row }).onConflictDoUpdate({
    target: [modelDiagrams.brandKey, modelDiagrams.exactModel],
    set: { ...row, importedAt: new Date() },
    setWhere: and(eq(modelDiagrams.sourceSha256, expectedSha256), ne(modelDiagrams.sourceSha256, sourceSha256))
  }).returning({ sourceSha256: modelDiagrams.sourceSha256 });
  return Boolean(saved) || (await getModelDiagrams(db, model))?.sourceSha256 === sourceSha256;
}
