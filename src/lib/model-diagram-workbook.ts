import "server-only";
import { createHash } from "node:crypto";
import type { Cell, Row, Worksheet } from "exceljs";
import { encompassManufacturerCodes } from "@/src/sources/encompass";
import { canonicalizeMpn } from "./mpn";
import { exactDiagramModel, type ModelDiagrams, type ModelDiagramSection } from "./model-diagrams";

const MAX_WORKBOOK_BYTES = 2 * 1024 * 1024;
const ENCOMPASS_HOSTS = ["encompass.com", "www.encompass.com", "partstore.encompass.com"];
const IMAGE_HOST = "cdn.datamanager.arinet.com";

export class DiagramWorkbookError extends Error {}

function diagramSheet(sheet: Worksheet | undefined, name: string, headers: string[]) {
  if (!sheet || headers.some((header, index) => sheet.getRow(1).getCell(index + 1).text.trim().toLowerCase() !== header.toLowerCase())) {
    throw new DiagramWorkbookError(`The ${name} sheet must start with ${headers.join(", ")}.`);
  }
  return sheet;
}

function httpsLink(cell: Cell) {
  try {
    const url = new URL(cell.hyperlink || cell.text.trim());
    if (url.protocol === "https:" && !url.username && !url.password && !url.port) return url;
  } catch {
    // An XLSX cell can display a link label with no target, as in a CSV export.
  }
  return null;
}

function readSource(cell: Cell, brand: string, model: string) {
  const url = httpsLink(cell);
  const path = url && /^\/Exploded-View-Assembly\/([A-Z0-9]+)\/\d+\/([^/]+)\/?$/i.exec(url.pathname);
  if (!url || !ENCOMPASS_HOSTS.includes(url.hostname) || !path) {
    throw new DiagramWorkbookError("The Source row must link to the Encompass exploded view for this exact model.");
  }
  let sourceModel: string;
  try {
    sourceModel = decodeURIComponent(path[2]);
  } catch {
    throw new DiagramWorkbookError("The Encompass Source link has an invalid model number.");
  }
  const manufacturer = path[1].toUpperCase();
  if (!encompassManufacturerCodes(brand).includes(manufacturer) || exactDiagramModel(sourceModel) !== exactDiagramModel(model)) {
    throw new DiagramWorkbookError(`The Encompass Source link does not match ${brand} ${model} exactly.`);
  }
  return { sourceUrl: url.href, manufacturer };
}

function diagramImage(cell: Cell, manufacturer: string, assembly: string) {
  const url = httpsLink(cell);
  const image = url && /^\/image\/([A-Z0-9]+)\/[^/]+\/Max\/?$/i.exec(url.pathname);
  if (!url || url.hostname !== IMAGE_HOST || image?.[1].toUpperCase() !== manufacturer) {
    throw new DiagramWorkbookError(`The ${assembly} section needs a full-size Encompass diagram link. Upload the XLSX with its hyperlinks.`);
  }
  return url.href;
}

export async function readModelDiagramWorkbook(
  file: File, brand: string, model: string
): Promise<ModelDiagrams & { sourceSha256: string }> {
  if (!/\.xlsx$/i.test(file.name) || !file.size || file.size > MAX_WORKBOOK_BYTES) {
    throw new DiagramWorkbookError("Choose a nonempty XLSX diagram workbook up to 2 MiB.");
  }
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  const bytes = await file.arrayBuffer();
  try {
    await workbook.xlsx.load(bytes);
  } catch {
    throw new DiagramWorkbookError("The XLSX diagram workbook could not be read.");
  }
  const diagrams = diagramSheet(workbook.getWorksheet("Diagrams"), "Diagrams", ["Assembly", "Callouts", "Diagram", "Note"]);
  const parts = diagramSheet(workbook.getWorksheet("Parts"), "Parts", ["Assembly", "Callout", "Part Number", "Description", "Diagram"]);
  const diagramRows: Row[] = [];
  diagrams.eachRow((row, index) => {
    if (index > 1) diagramRows.push(row);
  });
  const sourceRows = diagramRows.filter((row) => row.getCell(1).text.trim().toLowerCase() === "source");
  if (sourceRows.length !== 1) throw new DiagramWorkbookError("Include one Source row on the Diagrams sheet.");
  const source = sourceRows[0];
  const { sourceUrl, manufacturer } = readSource(source.getCell(3), brand, model);
  const sections = new Map<string, { diagram: ModelDiagramSection; rowsExpected: number }>();
  for (const row of diagramRows) {
    if (row === source) continue;
    const assembly = row.getCell(1).text.trim();
    const key = assembly.toLowerCase();
    const count = row.getCell(2).text.trim();
    if (!assembly || sections.has(key) || !/^\d+$/.test(count) || !Number.isSafeInteger(Number(count))) {
      throw new DiagramWorkbookError(`Invalid assembly or callout count on Diagrams row ${row.number}.`);
    }
    sections.set(key, {
      rowsExpected: Number(count),
      diagram: { assembly, imageUrl: diagramImage(row.getCell(3), manufacturer, assembly), note: row.getCell(4).text.trim(), parts: [] }
    });
  }
  if (!sections.size) throw new DiagramWorkbookError("Include at least one assembly on the Diagrams sheet.");

  parts.eachRow((row, index) => {
    if (index === 1) return;
    const section = sections.get(row.getCell(1).text.trim().toLowerCase())?.diagram;
    const callout = row.getCell(2).text.trim();
    const partNumber = row.getCell(3).text.trim();
    if (!section || !callout || !canonicalizeMpn(partNumber)) {
      throw new DiagramWorkbookError(`Parts row ${index} needs a known assembly, a callout, and a part number.`);
    }
    const diagramCell = row.getCell(5);
    if (diagramCell.text && httpsLink(diagramCell)?.href !== section.imageUrl) {
      throw new DiagramWorkbookError(`The diagram on Parts row ${index} does not match ${section.assembly}.`);
    }
    section.parts.push({ callout, partNumber, description: row.getCell(4).text.trim() });
  });

  for (const { diagram, rowsExpected } of sections.values()) {
    if (diagram.parts.length !== rowsExpected) {
      throw new DiagramWorkbookError(`${diagram.assembly} lists ${rowsExpected} callouts but has ${diagram.parts.length} part rows.`);
    }
  }
  return {
    sourceUrl, sourceNote: source.getCell(4).text.trim(),
    sections: [...sections.values()].map(({ diagram }) => diagram),
    sourceSha256: createHash("sha256").update(new Uint8Array(bytes)).digest("hex")
  };
}
