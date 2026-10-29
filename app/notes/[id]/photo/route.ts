import { getDb, hasDatabase } from "@/src/db";
import { getTechNotePhoto } from "@/src/db/tech-notes";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!hasDatabase()) return new Response("Database not connected", { status: 503 });
  const { id } = await params;
  const photo = await getTechNotePhoto(await getDb(), id);
  if (!photo) return new Response("No photo", { status: 404 });
  return new Response(new Uint8Array(photo.bytes), {
    headers: { "content-type": photo.type, "cache-control": "private, max-age=86400", "x-content-type-options": "nosniff" }
  });
}
