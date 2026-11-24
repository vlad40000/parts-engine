import { identityToken } from "../identity";
import { calloutGaps, calloutRow, finishAttempt, keepDistinct } from "./outcome";
import type { DiagramAttempt, DiagramCallout, DiagramQuery, DiagramSection, FetchRecord, UnreadRow } from "./types";

/**
 * Whirlpool-family repair parts list (PDF) read from `pdftotext -raw` output, pages separated by form feeds.
 * Layout verified on Maytag W11497934 Rev. B (2021-04-06): a cover page naming each model and its finish, then
 * for each assembly a drawing page and a parts key headed "Illus. / No. Part No. Description". A callout line
 * starts with the illustration number; a line starting with a part number under it is a sub-row (a finish such as
 * "White", or a literature item). "OPTIONAL PARTS (NOT INCLUDED)" has no drawing and no callouts.
 */
export type OemCallout = { callout: string; partNumber: string | null; description: string; subRows: Array<{ partNumber: string; label: string }> };
export type OemLoosePart = { group: string; partNumber: string; description: string };
export type OemSection = { title: string; drawingPage: number | null; partsPages: number[]; callouts: OemCallout[]; unillustrated: OemLoosePart[] };
export type OemPartsList = {
  documentNumber: string | null;
  revision: string | null;
  date: string | null;
  models: Array<{ model: string; label: string }>;
  pageCount: number;
  sections: OemSection[];
};

const FOOTER = /^(\d{2}\/\d{2}\/\d{4})\b.*\bPart No\.\s+([A-Z0-9]+)\s+Rev\.\s+([A-Z0-9]+)\s*$/i;
const COLUMN_HEADER = /^(Illus\.|No\. Part No\. Description)$/i;
const CALLOUT = /^(\d{1,3}[A-Z]?)(?:\s+(.*))?$/;

/** A part number has a digit and at least five characters, so it is never an illustration number. */
export function isPartNumberToken(token: string): boolean {
  return /^[A-Z0-9][A-Z0-9-]{4,}$/i.test(token) && /\d/.test(token);
}

const isHeading = (line: string) => /[A-Z]/.test(line) && line === line.toUpperCase() && !isPartNumberToken(line.split(/\s+/)[0]);
const join = (a: string, b: string) => `${a} ${b.replace(/^[.\s]+/, "")}`.replace(/\s+/g, " ").trim();
const firstToken = (line: string) => {
  const i = line.search(/\s/);
  return i < 0 ? [line, ""] : [line.slice(0, i), line.slice(i + 1).trim()];
};

export function parseOemPartsListText(text: string): OemPartsList {
  const pages = text.replace(/\r\n?/g, "\n").split("\f");
  while (pages.length && !pages[pages.length - 1].trim()) pages.pop();
  const list: OemPartsList = { documentNumber: null, revision: null, date: null, models: [], pageCount: pages.length, sections: [] };
  const byTitle = new Map<string, OemSection>();

  pages.forEach((page, i) => {
    const pageNo = i + 1;
    const lines: string[] = [];
    for (const raw of page.split("\n")) {
      const line = raw.replace(/\s+/g, " ").trim();
      if (!line) continue;
      const footer = FOOTER.exec(line);
      if (footer) {
        list.date ??= footer[1];
        list.documentNumber ??= footer[2].toUpperCase();
        list.revision ??= footer[3].toUpperCase();
        continue;
      }
      lines.push(line);
    }
    const modelsAt = lines.findIndex((l) => /^MODELS:$/i.test(l));
    if (modelsAt >= 0) {
      for (const l of lines.slice(modelsAt + 1)) {
        const m = /^([A-Z0-9][A-Z0-9./-]{3,})\s+\(([^)]+)\)$/i.exec(l);
        if (m) list.models.push({ model: m[1].toUpperCase(), label: m[2].trim() });
      }
      return;
    }
    if (!lines.length || !isHeading(lines[0])) return;
    const title = lines[0];
    const section = byTitle.get(title) ?? { title, drawingPage: null, partsPages: [], callouts: [], unillustrated: [] };
    if (!byTitle.has(title)) {
      byTitle.set(title, section);
      list.sections.push(section);
    }
    const body = lines.slice(1);
    if (!body.some((l) => COLUMN_HEADER.test(l))) {
      section.drawingPage ??= pageNo;
      return;
    }
    section.partsPages.push(pageNo);
    const content = body.filter((l) => !COLUMN_HEADER.test(l));
    if (section.drawingPage === null) readLooseParts(section, content);
    else readCallouts(section, content);
  });
  return list;
}

function readCallouts(section: OemSection, lines: string[]) {
  let current = section.callouts.at(-1) ?? null;
  let lastNumber = current ? Number.parseInt(current.callout, 10) : 0;
  let target: "description" | "sub" = "description";
  for (const line of lines) {
    const m = CALLOUT.exec(line);
    if (m && Number.parseInt(m[1], 10) >= lastNumber) {
      const [token, rest] = firstToken(m[2] ?? "");
      current = isPartNumberToken(token)
        ? { callout: m[1].toUpperCase(), partNumber: token.toUpperCase(), description: rest, subRows: [] }
        : { callout: m[1].toUpperCase(), partNumber: null, description: (m[2] ?? "").trim(), subRows: [] };
      section.callouts.push(current);
      lastNumber = Number.parseInt(m[1], 10);
      target = "description";
      continue;
    }
    if (!current) continue;
    const [token, rest] = firstToken(line);
    if (isPartNumberToken(token)) {
      current.subRows.push({ partNumber: token.toUpperCase(), label: rest });
      target = "sub";
    } else if (target === "sub" && current.subRows.length) {
      const sub = current.subRows[current.subRows.length - 1];
      sub.label = join(sub.label, line);
    } else {
      current.description = join(current.description, line);
    }
  }
}

function readLooseParts(section: OemSection, lines: string[]) {
  let group = "";
  let last: OemLoosePart | null = null;
  let headingOpen = false;
  for (const line of lines) {
    const [token, rest] = firstToken(line);
    if (isPartNumberToken(token)) {
      last = { group, partNumber: token.toUpperCase(), description: rest };
      section.unillustrated.push(last);
      headingOpen = false;
    } else if (isHeading(line)) {
      group = headingOpen ? join(group, line) : line;
      headingOpen = true;
      last = null;
    } else if (last) {
      last.description = join(last.description, line);
    } else if (headingOpen) {
      group = join(group, line);
    }
  }
}

/**
 * The parts list as diagram evidence for one model. The document must name the queried model on its cover;
 * a sibling (another finish or revision) is refused. Every finish row is kept: the list does not say which
 * finish a given machine carries beyond the cover's model-to-finish legend, so no row is chosen or dropped.
 */
export function oemPartsListAttempt(
  q: DiagramQuery, list: OemPartsList, src: { pdfUrl: string; retrievedAt: string; fetches: FetchRecord[] }
): DiagramAttempt {
  const doc = `${list.documentNumber ?? "parts list"}${list.revision ? ` Rev. ${list.revision}` : ""}`;
  const base = { provider: "oem-parts-list" as const, query: q, retrievedAt: src.retrievedAt, fetches: src.fetches, sourceUrl: src.pdfUrl };
  const named = list.models.find((m) => identityToken(m.model) === identityToken(q.model));
  if (!named || q.variation) {
    return finishAttempt({ ...base, sections: [], missing: [], expectedSections: null,
      identity: `cover names ${list.models.map((m) => m.model).join(", ") || "no model"}`,
      blocked: q.variation
        ? `${doc} names models without a manufacturer variation; it cannot be shown to be ${q.variation}.`
        : `${doc} covers ${list.models.map((m) => m.model).join(", ") || "no named model"}, not ${q.brand} ${q.model}; nothing was read.` });
  }
  const sections: DiagramSection[] = [];
  const missing: string[] = [];
  for (const s of list.sections) {
    if (!s.partsPages.length) {
      missing.push(`${s.title}: drawing on page ${s.drawingPage} has no parts key`);
      continue;
    }
    const rows: DiagramCallout[] = [];
    const unreadRows: UnreadRow[] = [];
    for (const c of s.callouts) {
      if (c.partNumber) rows.push(calloutRow(c.callout, c.partNumber, c.description, null));
      for (const sub of c.subRows) rows.push(calloutRow(c.callout, sub.partNumber, c.description, null, sub.label));
      if (!c.partNumber && !c.subRows.length) unreadRows.push({ callout: c.callout, supplierPartId: null, description: c.description, reason: "no part number printed" });
    }
    const { callouts, duplicateRows } = keepDistinct(rows);
    // The key numbers its drawing 1..N, so a skipped number is a gap in this copy of the catalog.
    const gaps = calloutGaps([...callouts, ...unreadRows]);
    if (gaps.length) missing.push(`${s.title}: Illus. No. ${gaps.join(", ")} not in the parts key`);
    sections.push({
      assembly: s.title,
      sourcePageUrl: `${src.pdfUrl}#page=${s.partsPages[0]}`,
      diagramUrl: s.drawingPage === null ? null : `${src.pdfUrl}#page=${s.drawingPage}`,
      illustrated: s.drawingPage !== null,
      callouts,
      uncalloutedRows: s.unillustrated.map((p) => {
        const { callout: _none, ...row } = calloutRow("", p.partNumber, p.description, null, p.group || null);
        return row;
      }),
      duplicateRows, unreadRows
    });
  }
  return finishAttempt({ ...base, sections, missing, expectedSections: list.sections.length,
    identity: `cover of ${doc} (${list.date ?? "undated"}) names ${named.model} (${named.label})` });
}
