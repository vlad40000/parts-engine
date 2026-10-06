import { parseCsvRecords } from "./csv";

export function cellText(v: unknown): string {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("richText" in o && Array.isArray(o.richText)) return o.richText.map((t) => String((t as { text?: unknown }).text ?? "")).join("").trim();
    if ("text" in o) return String(o.text ?? "").trim();
    if ("result" in o) return cellText(o.result);
  }
  return String(v).trim();
}

/**
 * Reads the first sheet (or `preferSheet`) whose first ten rows contain a row the
 * `isHeader` predicate accepts. Values keep their native types (Date, number).
 */
export async function readXlsx(
  buffer: ArrayBuffer,
  isHeader: (cells: string[]) => boolean,
  preferSheet?: string
): Promise<Array<Record<string, unknown>>> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const sheets = [...wb.worksheets].sort((a, b) => Number(b.name === preferSheet) - Number(a.name === preferSheet));
  for (const ws of sheets) {
    let headerRow = 0;
    let headers: string[] = [];
    for (let r = 1; r <= Math.min(ws.rowCount, 10); r += 1) {
      const values = (ws.getRow(r).values as unknown[]).slice(1).map(cellText);
      if (isHeader(values)) { headerRow = r; headers = values; break; }
    }
    if (!headerRow) continue;
    const records: Array<Record<string, unknown>> = [];
    for (let r = headerRow + 1; r <= ws.rowCount; r += 1) {
      const values = (ws.getRow(r).values as unknown[]).slice(1);
      const rec: Record<string, unknown> = {};
      headers.forEach((h, i) => {
        if (!h) return;
        const v = values[i];
        rec[h] = v && typeof v === "object" && !(v instanceof Date) ? cellText(v) : v ?? "";
      });
      records.push(rec);
    }
    return records;
  }
  return [];
}

export async function readTable(
  name: string,
  buffer: ArrayBuffer,
  isHeader: (cells: string[]) => boolean,
  preferSheet?: string
): Promise<Array<Record<string, unknown>>> {
  if (/\.csv$/i.test(name)) return parseCsvRecords(new TextDecoder().decode(buffer));
  return readXlsx(buffer, isHeader, preferSheet);
}
