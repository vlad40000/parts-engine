import { NextResponse } from "next/server";
import JSZip from "jszip";
import { getDb } from "@/src/db";
import { researchQueueExport, researchQueueExports } from "@/src/db/queries";
import { SharedResearchExportError, SHARED_RESEARCH_MAX_ROWS, SHARED_RESEARCH_MAX_BYTES } from "@/src/lib/shared-research-csv";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Single CSV (batch N) or all numbered shared-import-compatible CSVs in one ZIP. Read-only. */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const all = params.get("all");
  const batchParam = params.get("batch");
  if ((all !== null && all !== "1") || (all === "1" && batchParam !== null) ||
      (batchParam !== null && !/^[1-9]\d*$/.test(batchParam))) {
    return NextResponse.json({ error: "Use either all=1 or a positive integer batch number." }, { status: 400 });
  }
  const batchNumber = batchParam === null ? 1 : Number(batchParam);
  if (!Number.isSafeInteger(batchNumber)) {
    return NextResponse.json({ error: "Invalid research queue batch number." }, { status: 400 });
  }
  const day = new Date().toISOString().slice(0, 10);
  try {
    const db = await getDb();
    if (all === "1") {
      const batches = await researchQueueExports(db);
      const zip = new JSZip();
      const digitWidth = Math.max(3, String(batches.length).length);
      const number = (n: number) => String(n).padStart(digitWidth, "0");
      batches.forEach((b, i) => zip.file(`research-queue-${day}-part-${number(i + 1)}-of-${number(batches.length)}.csv`, b.csv));
      const omitted = batches[0]?.omittedMpns ?? [];
      const blankPrices = batches.flatMap((b) => b.blankNewPrices);
      zip.file("README.txt", [
        `Research queue snapshot: ${day}`,
        `MPNs exported: ${batches.reduce((n, b) => n + b.exported, 0)}`,
        `CSV batches: ${batches.length} (each at most ${SHARED_RESEARCH_MAX_ROWS} rows and ${SHARED_RESEARCH_MAX_BYTES} bytes, with headroom for research edits)`,
        `MPNs omitted (D1 key longer than 200 characters): ${omitted.length}`,
        ...omitted.map((mpn) => `  OMITTED: ${mpn}`),
        `Rows with New Price left blank (invalid or outside accepted range): ${blankPrices.length}`,
        ...blankPrices.map((r) => `  PRICE BLANK: ${r.mpnCanonical}`),
        "All CSVs have the existing shared research headers and can be imported separately.",
        "Exporting does not mark MPNs researched or change their queue status."
      ].join("\n") + "\n");
      const archive = await zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE", compressionOptions: { level: 3 } });
      return new NextResponse(archive, {
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="research-queue-${day}-all-batches.zip"`,
          "Cache-Control": "private, no-store"
        }
      });
    }
    const { csv } = await researchQueueExport(db, batchNumber);
    const suffix = batchNumber === 1 ? "" : `-part-${numberOrPad(batchNumber)}`;
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="research-queue-${day}${suffix}.csv"`,
        "Cache-Control": "private, no-store"
      }
    });
  } catch (error) {
    if (error instanceof SharedResearchExportError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    throw error;
  }
}

function numberOrPad(n: number) { return String(n).padStart(3, "0"); }
