import JSZip from "jszip";
import { parseCsvRows } from "./csv";
import { cellText, readTable } from "./table-read";
import { EVIDENCE_MAX_BYTES, EVIDENCE_MAX_ROWS, evidenceHash, evidenceHeader, parseEvidenceTable, ResearchEvidenceError, type EvidenceFile, type EvidenceOptions } from "./research-evidence";

const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** ExcelJS expects unprefixed SpreadsheetML element names. Normalize only prefixes
 * explicitly bound to that namespace; r:id and other namespaces remain untouched. */
export async function compatibleEvidenceWorkbook(bytes: Uint8Array): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(bytes);
  let size = 0, changed = false;
  for (const entry of Object.values(zip.files)) {
    if (entry.dir || !/^xl\/.*\.(?:xml|rels)$/.test(entry.name)) continue;
    const xml = await entry.async("string");
    size += Buffer.byteLength(xml);
    if (size > 25 * 1024 * 1024) throw new ResearchEvidenceError("The expanded workbook is too large. Export its research sheet as CSV.");
    const aliases = [...xml.matchAll(/xmlns:([A-Za-z_][\w.-]*)=["']([^"']+)["']/g)]
      .filter((m) => m[2] === MAIN).map((m) => m[1]);
    let normalized = xml;
    // ExcelJS keys worksheet comments/tables/VML by relative target paths.
    if (/^xl\/worksheets\/_rels\/[^/]+\.rels$/.test(entry.name)) {
      normalized = normalized.replace(/<Relationship\b[^>]*>/g, (tag) => {
        // VML is comment-box formatting, not research cell content. Some generators
        // use VML filenames ExcelJS cannot load. Omit that pointer in this read copy.
        if (/\/vmlDrawing["']/.test(tag)) return "";
        return /TargetMode=["']External["']/.test(tag) ? tag : tag.replace(/Target=(["'])\/xl\//, "Target=$1../");
      });
    }
    for (const alias of new Set(aliases)) {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if ([...xml.matchAll(new RegExp(`xmlns:${escaped}=["']([^"']+)["']`, "g"))].some((m) => m[1] !== MAIN)) {
        throw new ResearchEvidenceError("The workbook reuses an XML namespace prefix. Export its research sheet as CSV.");
      }
      normalized = normalized.replace(new RegExp(`<(/?)${escaped}:([A-Za-z_][\\w.-]*)`, "g"), "<$1$2");
    }
    if (aliases.length) normalized = normalized.replace(/<(?!\?)([A-Za-z_][\w.-]*)(\s[^>]*|\s*)>/, (tag) => /\sxmlns=/.test(tag) ? tag : tag.replace(/\s*(\/?)>$/, ` xmlns="${MAIN}"$1>`));
    if (normalized !== xml) { zip.file(entry.name, normalized); changed = true; }
  }
  return changed ? zip.generateAsync({type:"uint8array"}) : bytes;
}

/** Uses the existing CSV/table infrastructure, with an isolated workbook compatibility
 * adapter and explicit sheet selection so copied historical tabs are never merged. */
export async function readResearchEvidenceFile(file: File, options: EvidenceOptions): Promise<EvidenceFile> {
  if (!/\.(csv|xlsx)$/i.test(file.name)) throw new ResearchEvidenceError("Choose a CSV or XLSX research file.");
  if (!file.size || file.size > EVIDENCE_MAX_BYTES) throw new ResearchEvidenceError("Choose a nonempty research file up to 2 MiB.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  let records: Record<string, unknown>[];
  let sheet: string | null = null;
  if (/\.csv$/i.test(file.name)) {
    const text=new TextDecoder().decode(bytes);
    let quoted=false;
    for(let i=0;i<text.length;i++){
      if(text[i]!=="\"")continue;
      if(quoted && text[i+1]==="\""){i++;continue;}
      quoted=!quoted;
    }
    if(quoted)throw new ResearchEvidenceError("The CSV has an unclosed quoted field.");
    const table = parseCsvRows(text);
    const headers = table[0] ?? [];
    if(table.slice(1).some((r)=>r.length!==headers.length))throw new ResearchEvidenceError("Each CSV row must have the same number of cells as the header.");
    if (new Set(headers.map(norm)).size !== headers.length) throw new ResearchEvidenceError("The file has duplicate headers. Keep one of each.");
    records = await readTable("research.csv", bytes.buffer as ArrayBuffer, evidenceHeader);
  } else {
    try {
      const ExcelJS = (await import("exceljs")).default;
      const wb = new ExcelJS.Workbook();
      const normalized = await compatibleEvidenceWorkbook(bytes);
      await wb.xlsx.load(normalized.buffer.slice(normalized.byteOffset, normalized.byteOffset + normalized.byteLength) as ArrayBuffer);
      const sheets = [...wb.worksheets].sort((a, b) => Number(b.name === "Research Order") - Number(a.name === "Research Order"));
      records = [];
      for (const ws of sheets) {
        let headerRow = 0, headers: string[] = [];
        for (let r = 1; r <= Math.min(ws.rowCount, 10); r++) {
          const row = (ws.getRow(r).values as unknown[]).slice(1).map(cellText);
          if (evidenceHeader(row)) {headerRow = r; headers = row; break;}
        }
        if (!headerRow) continue;
        if (new Set(headers.filter(Boolean).map(norm)).size !== headers.filter(Boolean).length) throw new ResearchEvidenceError("The research sheet has duplicate headers.");
        if (ws.rowCount - headerRow > EVIDENCE_MAX_ROWS) throw new ResearchEvidenceError(`Supply at most ${EVIDENCE_MAX_ROWS} research rows.`);
        sheet = ws.name;
        for (let r = headerRow + 1; r <= ws.rowCount; r++) {
          const values = (ws.getRow(r).values as unknown[]).slice(1);
          if (!values.some((v) => v != null && cellText(v))) continue;
          const record: Record<string, unknown> = {};
          headers.forEach((h, i) => {
            if (!h) return;
            const value = values[i];
            record[h] = value && typeof value === "object" && !(value instanceof Date) ? cellText(value) : value ?? null;
          });
          record.__sourceRow = r;
          records.push(record);
        }
        break;
      }
    } catch (error) {
      if (error instanceof ResearchEvidenceError) throw error;
      throw new ResearchEvidenceError("The workbook could not be read. Export its research sheet as CSV and preview again.");
    }
  }
  const headers = Object.keys(records[0] ?? {}).map(norm);
  const format = sheet === "Research Order" && headers.includes("ownerdecision") ? "master_workbook"
    : headers.includes("90daysold") ? "owner_workbook" : "evidence_table";
  return parseEvidenceTable(records, {sourceSha256:evidenceHash(bytes), format, sheet, options});
}
