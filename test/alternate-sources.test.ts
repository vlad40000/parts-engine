import { describe, expect, it } from "vitest";
import { lookupPartsDr, parsePartsDrPage } from "@/src/sources/partsdr";
import { lookupPartSelect, matchesPartSelectModel, parsePartSelectPage } from "@/src/sources/partselect";
import { lookupModelBom } from "@/src/sources/chain";
import { supplierUrl } from "@/src/sources/html-catalog";
import { catalogFetcher, captures } from "./catalog-fixture";
const samsung = { brand: "Samsung", model: "DV45H7000EW/A2" };
const ge = { brand: "GE", model: "GSD3460G00SS" };
const revision = { brand: "Samsung", model: "DV45H7000EW/A2-0000" };

describe("captured HTML catalogs: exact model and complete pagination", () => {
  it.each([
    ["Parts Dr Samsung", lookupPartsDr, samsung, 73, 2, 73],
    ["Parts Dr GE", lookupPartsDr, ge, 126, 4, 126],
    ["PartSelect GE", lookupPartSelect, ge, 126, 11, 126],
    ["PartSelect Samsung exact revision", lookupPartSelect, revision, 125, 11, 126]
  ] as const)("%s reconciles the published count before returning OEM rows", async (_, lookup, q, rows, pages, total) => {
    const { fetcher } = catalogFetcher();
    const r = await lookup(q, fetcher);
    expect(r).toMatchObject({ status: "found", completeness: "complete", catalogPages: pages, catalogRows: total });
    expect(r.rows).toHaveLength(rows);
    expect(r.rows.every((p) => /^[A-Z0-9]+$/.test(p.mpnCanonical) && !/^(PS|PD|AP)\d+$/.test(p.mpnCanonical))).toBe(true);
  });
  it("retains unavailable, unlinked Parts Dr OEMs without inventing price or permanent NLA", async () => {
    const r = await lookupPartsDr(samsung, catalogFetcher().fetcher);
    expect(r.rows.find((p) => p.mpnDisplay === "DC63-01026A")).toMatchObject({ newPrice: null, nla: false });
    expect(r.rows.find((p) => p.mpnDisplay === "DC47-00019A")).toMatchObject({ newPrice: 74.07 });
  });
  it("keeps the PartSelect retailer ID separate and accounts for its contact placeholder", async () => {
    const r = await lookupPartSelect(revision, catalogFetcher().fetcher);
    expect(r.rows.find((p) => p.mpnDisplay === "6602-001655")).toMatchObject({ supplierPartId: "PS4133825", mpnCanonical: "6602001655" });
    expect(r).toMatchObject({ droppedRows: 1 });
    expect(r.warnings.join(" ")).toContain("contact placeholders were excluded");
    expect(r.rows.some((p) => /CALL|1800SAMSUNG/.test(p.mpnCanonical))).toBe(false);
  });
  it("refuses an ambiguous Samsung /A2 rather than choosing one PartSelect revision", async () => {
    const { fetcher, calls } = catalogFetcher();
    const r = await lookupPartSelect(samsung, fetcher);
    expect(r).toMatchObject({ status: "error", rows: [] });
    expect(r.warnings.join(" ")).toContain("exact suffix");
    expect(calls).toHaveLength(1);
  });
  it("does not collapse revision zeros, omit slash suffixes, or accept a different brand", () => {
    const html = '<h1>DV45H7000EW (A2-01) Samsung Dryer - Parts</h1>';
    expect(matchesPartSelectModel(html, { ...samsung, model: "DV45H7000EW/A2-01" })).toBe(true);
    for (const model of ["DV45H7000EW/A2-0001", "DV45H7000EW/A2", "DV45H7000EWA2-01"]) expect(matchesPartSelectModel(html, { ...samsung, model })).toBe(false);
    expect(matchesPartSelectModel(html, { brand: "GE", model: "DV45H7000EW/A2-01" })).toBe(false);
  });
});

describe.each([
  ["Parts Dr", lookupPartsDr, samsung, "page=2", "73", "Parts for this appliance 73 parts"],
  ["PartSelect", lookupPartSelect, ge, "start=2", "126", "1 - 12 of 126"]
] as const)("%s rejects incomplete or untrusted catalogs", (_, lookup, q, page2, total, count) => {
  it.each(["http", "wrong-model", "redirect", "repeat"])("rejects page two %s with zero returned rows", async (failure) => {
    let firstHtml = "";
    const { fetcher } = catalogFetcher((r, url) => {
      if (/\/(?:parts|Parts\/)$/i.test(new URL(url).pathname) && !new URL(url).search) firstHtml = r.html;
      if (!url.includes(page2)) return r;
      if (failure === "http") return { ...r, ok: false, status: 403 };
      if (failure === "wrong-model") return { ...r, html: r.html.replaceAll(q.model.split("/")[0], "WRONG123") };
      if (failure === "redirect") return { ...r, finalUrl: "https://example.org/fake" };
      return { ...r, html: firstHtml };
    });
    expect(await lookup(q, fetcher)).toMatchObject({ status: "error", rows: [] });
  });
  it("does not import a popular-parts page without a full-list link", async () => {
    const { fetcher } = catalogFetcher((r) => ({ ...r, html: r.html.replaceAll(/href="[^"]*\/(?:parts|Parts\/)"/g, 'href="#"') }));
    expect(await lookup(q, fetcher)).toMatchObject({ status: "error", rows: [] });
  });
  it("rejects missing, oversized and inconsistent totals", async () => {
    for (const replacement of ["", count.replace(total, "6000"), count.replace(total, String(Number(total) + 1))]) {
      const { fetcher } = catalogFetcher((r) => ({ ...r, html: r.html.replace(count, replacement) }));
      expect(await lookup(q, fetcher)).toMatchObject({ status: "error", rows: [] });
    }
  });
  it("does not accept an incomplete catalog when pagination is absent", async () => {
    const { fetcher } = catalogFetcher((r) => ({ ...r, html: r.html.replaceAll(/href="[^"]*\?(?:page|start)=\d+"/g, 'href="#"') }));
    expect(await lookup(q, fetcher)).toMatchObject({ status: "error", rows: [] });
  });
  it("rejects an advertised page above the cap", async () => {
    const { fetcher } = catalogFetcher((r) => ({ ...r, html: r.html.replaceAll(page2, page2.replace("2", "51")) }));
    expect(await lookup(q, fetcher)).toMatchObject({ status: "error", rows: [] });
  });
});

it("only follows HTTPS links within the selected supplier host", () => {
  for (const href of ["https://evil.example/x", "http://partsdr.com/x", "https://user:pass@partsdr.com/x", "https://partsdr.com:444/x", "//evil.example/x"]) expect(supplierUrl(href, "https://partsdr.com")).toBeNull();
  expect(supplierUrl("/parts#x", "https://partsdr.com")).toBe("https://partsdr.com/parts");
});
it("unknown/missing OEMs and retailer IDs invalidate the page instead of being silently skipped", () => {
  for (const mpn of ["", "PS4133825", "AP123456", "Unknown", "CALL_SOMEONE"]) {
    expect(parsePartsDrPage(`<div>Parts for this appliance 1 parts</div><div><h4>Motor</h4><div>Part # ${mpn}</div></div>`)).toMatchObject({ cards: 1, dropped: 1, rows: [] });
    expect(parsePartSelectPage(`<div>1 - 1 of 1</div><div class="mega-m__part"><a class="mega-m__part__name">Motor</a><div>Part #${mpn}</div></div>`)).toMatchObject({ cards: 1, dropped: 1, rows: [] });
  }
});

it("explicit sources and automatic alternatives never call Encompass; automatic alternatives fall back", async () => {
  for (const source of ["partsdr", "partselect", "alternatives"] as const) {
    const fixture = catalogFetcher();
    const calls: string[] = [];
    const r = await lookupModelBom(ge, async (url) => {
      calls.push(url);
      if (source === "alternatives" && url.includes("partsdr.com")) return { ok: false, status: 403, finalUrl: url, html: "" };
      return fixture.fetcher(url);
    }, source);
    expect(r.status).toBe("found");
    expect(r.winner?.supplier).toBe(source === "partsdr" ? "partsdr" : "partselect");
    expect(calls.every((url) => /partsdr\.com|partselect\.com/.test(url))).toBe(true);
    if (source !== "alternatives") expect(r.attempts).toHaveLength(1);
    else expect(r.attempts.map((a) => a.supplier)).toEqual(["partsdr", "partselect"]);
  }
});
it("an alternate-source miss stays in Retries while the original chain is unchanged", async () => {
  const missing = async (url: string) => ({ ok: false, status: 404, finalUrl: url, html: "" });
  const alternate = await lookupModelBom(ge, missing, "partsdr");
  expect(alternate).toMatchObject({ status: "error", winner: null });
  expect(alternate.attempts[0].status).toBe("not_found");
  const original = await lookupModelBom(ge, missing);
  expect(original.attempts.map((a) => a.supplier)).toEqual(["encompass", "appliancepartspros"]);
});
it("fixtures contain no scripts, forms, event handlers, review text or session attributes", () => {
  for (const c of captures) expect(c.html).not.toMatch(/<script|<form|<input|onclick=|wire:|csrf|reviewText|CustomerReview|data-args=/i);
});
