import { NextResponse } from "next/server";
import JSZip from "jszip";
import { getDb } from "@/src/db";
import { fleetFacets, fleetMpnExportRows } from "@/src/db/queries";
import {
  buildAllSharedResearchExports, buildSharedResearchExport,
  SHARED_RESEARCH_MAX_BYTES, SHARED_RESEARCH_MAX_ROWS, SharedResearchExportError
} from "@/src/lib/shared-research-csv";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Read-only export of all MPNs found in cached BOMs for a selected fleet status set.
 * No queue, donor-eligibility, research freshness, family prefilter, or qualification gating.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const all = params.get("all");
  const batchParam = params.get("batch");
  const scope = params.get("scope");
  if ((all !== null && all !== "1") || (all === "1" && batchParam !== null) ||
      (batchParam !== null && !/^[1-9]\d*$/.test(batchParam))) {
    return NextResponse.json({ error: "Use either all=1 or a positive integer batch number." }, { status: 400 });
  }
  const batchNumber = batchParam === null ? 1 : Number(batchParam);
  if (!Number.isSafeInteger(batchNumber)) {
    return NextResponse.json({ error: "Invalid fleet export batch number." }, { status: 400 });
  }
  if (scope !== null && scope !== "selected") {
    return NextResponse.json({ error: "Invalid fleet status scope." }, { status: 400 });
  }

  const supplied = params.getAll("status");
  if ((scope === null && supplied.length) || (scope === "selected" && !supplied.length)) {
    return NextResponse.json({ error: "Use scope=selected with one or more machine statuses." }, { status: 400 });
  }

  try {
    const db = await getDb();
    let statuses: string[] | null = null;
    if (scope === "selected") {
      const known = new Set((await fleetFacets(db)).availability);
      statuses = [...new Set(supplied.map((value) => value.trim().toUpperCase()))];
      if (statuses.some((status) => !status || !known.has(status))) {
        return NextResponse.json({ error: "Unknown machine status selected. Refresh the MPN page and try again." }, { status: 400 });
      }
    }
    const rows = await fleetMpnExportRows(db, statuses);
    const date = new Date().toISOString().slice(0, 10);
    const name = `fleet-mpns-${date}-${statuses ? "selected-statuses" : "all-machines"}`;

    if (all === "1") {
      const batches = buildAllSharedResearchExports(rows);
      const zip = new JSZip();
      const digitWidth = Math.max(3, String(batches.length).length);
      const number = (n: number) => String(n).padStart(digitWidth, "0");
      batches.forEach((batch, i) =>
        zip.file(`${name}-part-${number(i + 1)}-of-${number(batches.length)}.csv`, batch.csv)
      );
      const omitted = batches[0]?.omittedMpns ?? [];
      const blankPrices = batches.flatMap((b) => b.blankNewPrices);
      zip.file("README.txt", [
        `Fleet MPN export snapshot: ${date}`,
        `Machine status scope: ${statuses ? statuses.join(", ") : "ALL STATUSES (including SOLD and SCRAPPED)"}`,
        `Distinct MPNs exported: ${batches.reduce((sum, b) => sum + b.exported, 0)}`,
        `CSV batches: ${batches.length} (each at most ${SHARED_RESEARCH_MAX_ROWS} MPNs / ${SHARED_RESEARCH_MAX_BYTES} bytes, with room for research)`,
        `Omitted keys over 200 characters: ${omitted.length}`,
        ...omitted.map((mpn) => `  OMITTED: ${mpn}`),
        `Rows with invalid or out-of-range New Price left blank: ${blankPrices.length}`,
        ...blankPrices.map((r) => `  PRICE BLANK: ${r.mpnCanonical}`),
        "",
        "Only MPNs in saved model parts lists are exported. Machines without cached BOMs contribute no unknown MPNs.",
        "A model fitment match does NOT prove that a part is still installed, tested, or harvestable.",
        "SOLD/SCRAPPED and other historical statuses are research-only and never become eligible donors through this export.",
        "Includes previously researched, prefiltered and unqualified MPNs; this is NOT the operational research queue.",
        "Each CSV uses the unchanged shared research headers and can be imported separately into Parts Engine or EbayDecisions.",
        "Exporting is read-only; it does not change status, qualifications, research dates or market facts."
      ].join("\n") + "\n");
      const archive = await zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE", compressionOptions: { level: 3 } });
      return new NextResponse(archive, {
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="${name}-all-batches.zip"`,
          "Cache-Control": "private, no-store"
        }
      });
    }

    // Individual numbered CSVs use the same stable ordering and byte-safe batching as the ZIP.
    let start = 0;
    let batch = buildSharedResearchExport(rows);
    for (let i = 1; i < batchNumber; i++) {
      if (!batch.later) throw new SharedResearchExportError("The requested fleet MPN batch does not exist.");
      start += batch.exported;
      batch = buildSharedResearchExport(rows, start);
    }
    if (batchNumber > 1 && batch.exported === 0) {
      throw new SharedResearchExportError("The requested fleet MPN batch does not exist.");
    }
    const suffix = batchNumber === 1 ? "" : `-part-${String(batchNumber).padStart(3, "0")}`;
    return new NextResponse(batch.csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${name}${suffix}.csv"`,
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
