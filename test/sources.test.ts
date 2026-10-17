import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { encompassModelUrls, encompassPageCount, isInvalidModelPage, lookupEncompass, parseEncompassPage } from "@/src/sources/encompass";
import { extractSectionLinks, lookupAppliancePartsPros, oemFromSlug, parseSectionPage } from "@/src/sources/appliancepartspros";
import { lookupModelBom } from "@/src/sources/chain";
import { appSlugMatches, brandsCompatible, encompassModelCode } from "@/src/sources/identity";
import type { Fetcher } from "@/src/sources/types";

const fx = (p: string) => readFileSync(path.join(__dirname, "fixtures", p), "utf8");
const MAYTAG_PAGE = "https://www.appliancepartspros.com/parts-for-maytag-mvwx655dw1.html";

describe("Encompass", () => {
  it("builds brand-prefixed URLs, including the Samsung pipe form", () => {
    expect(encompassModelUrls("GE", "GDT535PSJ2SS")).toEqual(["https://partstore.encompass.com/model/HOTGDT535PSJ2SS"]);
    expect(encompassModelUrls("Maytag", "MVWX655DW1")).toEqual([
      "https://partstore.encompass.com/model/WHIMVWX655DW1",
      "https://partstore.encompass.com/model/MAYMVWX655DW1"
    ]);
    expect(encompassModelUrls("Samsung", "DV45H7000EW/A2")[1]).toBe("https://partstore.encompass.com/model/SMGDV45H7000EW%7CA2/0001/");
    expect(encompassModelUrls("Kenmore", "110.25132411")).toEqual(["https://partstore.encompass.com/model/KMR11025132411"]);
    expect(encompassModelUrls("Unknownco", "X")).toEqual([]);
  });

  it("parses the saved model page into OEM rows", () => {
    const rows = parseEncompassPage(fx("encompass/model-page.html"));
    expect(rows.length).toBeGreaterThan(20);
    for (const r of rows) {
      expect(r.mpnCanonical).toMatch(/^[A-Z0-9]{3,}$/);
    }
    expect(rows.some((r) => r.newPrice != null)).toBe(true);
  });

  it("pagination only follows real /_/N links", () => {
    expect(encompassPageCount('<a href="/model/HOTX/_/2">2</a><a href="/model/HOTX/_/3">3</a><span>120 parts</span>')).toBe(3);
    expect(encompassPageCount("<span>120</span>")).toBe(1);
  });

  it("detects the invalid-model page", () => {
    expect(isInvalidModelPage("Oops! This part or model# does not exist in our database.")).toBe(true);
  });

  it("falls through prefixes and returns found", async () => {
    const page = fx("encompass/model-page.html");
    const fetcher: Fetcher = async (url) =>
      url.includes("/WHI") ? { ok: true, status: 200, finalUrl: url, html: "does not exist in our database" } : { ok: true, status: 200, finalUrl: url, html: page };
    const r = await lookupEncompass({ brand: "Maytag", model: "MEDC465HW0" }, fetcher);
    expect(r.status).toBe("found");
    expect(r.sourceUrl).toContain("/MAY");
  });
});

describe("AppliancePartsPros", () => {
  it("reads every section link from the model page", () => {
    const links = extractSectionLinks(fx("app/MVWX655DW1-model.html"), "https://www.appliancepartspros.com/parts-for-maytag-mvwx655dw1.html");
    expect(links.length).toBe(6);
  });

  it("parses a section page with OEM from the slug", () => {
    const { rows } = parseSectionPage(fx("app/MVWX655DW1-top.html"));
    expect(rows.length).toBeGreaterThan(5);
    const top = rows.find((r) => r.supplierPartId === "AP6331297");
    expect(top).toMatchObject({ mpnDisplay: "W11233067", diagramId: "02 - Top And Cabinet", newPrice: 248.59 });
  });

  it("handles hyphenated Samsung OEMs and rejects word slugs", () => {
    expect(oemFromSlug("/samsung-heating-element-dc47-00019a-ap5328383.html", "AP5328383")).toBe("DC47-00019A");
    expect(oemFromSlug("/whirlpool-top-w11233067-ap6331297.html", "AP6331297")).toBe("W11233067");
    expect(oemFromSlug("/whirlpool-top-panel-ap6331297.html", "AP6331297")).toBe("");
    expect(oemFromSlug("/whirlpool-top-w11233067-ap999.html", "AP6331297")).toBe("");
  });

  it("runs the full model lookup against fixtures", async () => {
    const model = fx("app/MVWX655DW1-model.html");
    const section = fx("app/MVWX655DW1-top.html");
    const fetcher: Fetcher = async (url) => ({ ok: true, status: 200, finalUrl: url, html: url.includes("search.aspx") ? model : section });
    const r = await lookupAppliancePartsPros({ brand: "Maytag", model: "MVWX655DW1" }, fetcher);
    expect(r.status).toBe("found");
    expect(r.visited.length).toBe(7);
  });
});

describe("chain", () => {
  it("falls back to AppliancePartsPros when Encompass has no parts", async () => {
    const model = fx("app/MVWX655DW1-model.html");
    const section = fx("app/MVWX655DW1-top.html");
    const fetcher: Fetcher = async (url) => {
      if (url.includes("encompass")) return { ok: true, status: 200, finalUrl: url, html: "does not exist in our database" };
      return { ok: true, status: 200, finalUrl: url, html: url.includes("search.aspx") ? model : section };
    };
    const r = await lookupModelBom({ brand: "Maytag", model: "MVWX655DW1" }, fetcher);
    expect(r.status).toBe("found");
    expect(r.winner?.supplier).toBe("appliancepartspros");
    expect(r.attempts.map((a) => a.supplier)).toEqual(["encompass", "appliancepartspros"]);
  });

  it("never takes another model's parts through the fallback, and keeps the refusal retryable", async () => {
    // Before the identity check this Maytag MVWX655DW1 page was saved as the Frigidaire FFTW4120SW1 BOM.
    const fetcher: Fetcher = async (url) => {
      if (url.includes("encompass")) return { ok: true, status: 200, finalUrl: url, html: "does not exist in our database" };
      if (url.includes("search.aspx")) return { ok: true, status: 200, finalUrl: MAYTAG_PAGE, html: fx("app/MVWX655DW1-model.html") };
      return { ok: true, status: 200, finalUrl: url, html: fx("app/MVWX655DW1-top.html") };
    };
    const r = await lookupModelBom({ brand: "Frigidaire", model: "FFTW4120SW1" }, fetcher);
    // Every other supplier answered "no page", yet the result is error (Retries), never not_found.
    expect(r).toMatchObject({ status: "error", winner: null });
    expect(r.attempts.map((a) => [a.supplier, a.status])).toEqual([["encompass", "not_found"], ["appliancepartspros", "mismatch"]]);
  });

  it("keeps an identity refusal retryable for a brand Encompass does not list", async () => {
    // All 75 production not_found rows (audit 2026-10-17) had no Encompass brand prefix; a refusal
    // there would have closed the model as not found with no supplier error to keep it in Retries.
    const fetcher: Fetcher = async (url) => ({ ok: true, status: 200, finalUrl: url.includes("search.aspx") ? MAYTAG_PAGE : url,
      html: url.includes("search.aspx") ? fx("app/MVWX655DW1-model.html") : fx("app/MVWX655DW1-top.html") });
    const r = await lookupModelBom({ brand: "Crosley", model: "MVWX655DW1" }, fetcher);
    expect(r).toMatchObject({ status: "error", winner: null });
    expect(r.attempts.map((a) => [a.supplier, a.status])).toEqual([["encompass", "not_found"], ["appliancepartspros", "mismatch"]]);
    const placeholder = await lookupModelBom({ brand: "Crosley", model: "CDE7500?" }, fetcher);
    expect(placeholder.status).toBe("error");
  });

  it("reports error when every supplier fails on HTTP", async () => {
    const fetcher: Fetcher = async (url) => ({ ok: false, status: 403, finalUrl: url, html: "" });
    const r = await lookupModelBom({ brand: "GE", model: "GDT535PSJ2SS" }, fetcher);
    expect(r.status).toBe("error");
  });
});

describe("supplier page identity", () => {
  const model = fx("app/MVWX655DW1-model.html");
  const section = fx("app/MVWX655DW1-top.html");
  /** The search lands on `landing` (a redirect when it differs from the search URL). */
  const appFetcher = (landing: string | null, html = model, sectionPage = (url: string) => ({ finalUrl: url, html: section })) => {
    const calls: string[] = [];
    const fetcher: Fetcher = async (url) => {
      calls.push(url);
      if (url.includes("search.aspx")) return { ok: true, status: 200, finalUrl: landing ?? url, html };
      return { ok: true, status: 200, ...sectionPage(url) };
    };
    return { fetcher, calls };
  };

  it("matches brands by spelling and manufacturer, never across makers", () => {
    expect(brandsCompatible("GE", "general-electric")).toBe(true);
    expect(brandsCompatible("Hotpoint", "hot-point")).toBe(true);
    expect(brandsCompatible("GE", "hp")).toBe(true);
    expect(brandsCompatible("KitchenAid", "whirlpool")).toBe(true);
    expect(brandsCompatible("Admiral", "maytag")).toBe(true);
    expect(brandsCompatible("Frigidaire", "electrolux")).toBe(true);
    expect(brandsCompatible("Speed Queen", "alliance")).toBe(true);
    // Audit 2026-10-17: a model-only search filed these under another maker.
    expect(brandsCompatible("Samsung", "general-electric")).toBe(false);
    expect(brandsCompatible("Whirlpool", "frigidaire")).toBe(false);
    expect(brandsCompatible("Kenmore", "frigidaire")).toBe(false);
    expect(brandsCompatible("", "maytag")).toBe(false);
  });

  it("matches the exact model, never a longer revision or an unread character", () => {
    expect(appSlugMatches({ brand: "Maytag", model: "MVWX655DW1" }, "maytag-mvwx655dw1")).toBe(true);
    expect(appSlugMatches({ brand: "Samsung", model: "DVE45R6100P/A3" }, "samsung-dve45r6100p-a3")).toBe(true);
    expect(appSlugMatches({ brand: "Kenmore", model: "110.25132411" }, "kenmore-11025132411")).toBe(true);
    expect(appSlugMatches({ brand: "GE", model: "HTDX100ED3WW" }, "hot-point-htdx100ed3ww")).toBe(true);
    expect(appSlugMatches({ brand: "Whirlpool", model: "GR440LXLP" }, "whirlpool-gr440lxlp0")).toBe(false);
    expect(appSlugMatches({ brand: "Samsung", model: "DVE45R6100P/A3" }, "samsung-dve45r6100p-a3-00")).toBe(false);
    expect(appSlugMatches({ brand: "Whirlpool", model: "WCD5090JW?" }, "whirlpool-wcd5090jw0")).toBe(false);
    expect(appSlugMatches({ brand: "Whirlpool", model: "WCD5090JW?" }, "whirlpool-wcd5090jw")).toBe(false);
    expect(appSlugMatches({ brand: "Samsung", model: "GTW860SSJ1WS" }, "general-electric-gtw860ssj1ws")).toBe(false);
  });

  it("reads nothing from an AppliancePartsPros search that lands on another model", async () => {
    const { fetcher, calls } = appFetcher(MAYTAG_PAGE);
    const r = await lookupAppliancePartsPros({ brand: "Frigidaire", model: "FFTW4120SW1" }, fetcher);
    expect(r).toMatchObject({ status: "mismatch", rows: [], sourceUrl: null, visited: [MAYTAG_PAGE] });
    expect(r.warnings).toEqual([`AppliancePartsPros returned ${MAYTAG_PAGE}, which is not Frigidaire FFTW4120SW1; nothing was read from it.`]);
    expect(calls).toHaveLength(1);
  });

  it("rejects a longer revision and the same number under an unrelated brand", async () => {
    for (const q of [{ brand: "Maytag", model: "MVWX655DW" }, { brand: "Samsung", model: "MVWX655DW1" }]) {
      const r = await lookupAppliancePartsPros(q, appFetcher(MAYTAG_PAGE).fetcher);
      expect(r.status).toBe("mismatch");
      expect(r.rows).toEqual([]);
    }
  });

  it("accepts a same-manufacturer filing", async () => {
    const r = await lookupAppliancePartsPros({ brand: "Whirlpool", model: "MVWX655DW1" }, appFetcher(MAYTAG_PAGE).fetcher);
    expect(r.status).toBe("found");
    expect(r.sourceUrl).toBe(MAYTAG_PAGE);
  });

  it("checks the canonical link when the search is not redirected, and reads no page that names no model", async () => {
    const other = await lookupAppliancePartsPros({ brand: "Frigidaire", model: "FFTW4120SW1" }, appFetcher(null).fetcher);
    expect(other.status).toBe("mismatch");
    expect(other.warnings[0]).toContain(`returned ${MAYTAG_PAGE}, which is not Frigidaire FFTW4120SW1`);
    const unnamed = await lookupAppliancePartsPros({ brand: "Maytag", model: "MVWX655DW1" },
      appFetcher(null, model.replace(/<link rel="canonical"[^>]*>/i, "")).fetcher);
    expect(unnamed.status).toBe("mismatch");
    expect(unnamed.warnings[0]).toMatch(/does not name its model; nothing was read from it\.$/);
  });

  it("rejects the whole catalog when a section link or section redirect belongs to another model", async () => {
    const otherSection = "https://www.appliancepartspros.com/top-and-cabinet-parts-for-maytag-mvwx655dw2.html";
    // The other five sections are this model's own pages with parts; the catalog is still refused.
    const redirected = appFetcher(MAYTAG_PAGE, model, (url) =>
      url.includes("top-and-cabinet") ? { finalUrl: otherSection, html: section } : { finalUrl: url, html: section });
    const r = await lookupAppliancePartsPros({ brand: "Maytag", model: "MVWX655DW1" }, redirected.fetcher);
    expect(r).toMatchObject({ status: "mismatch", rows: [], sourceUrl: null });
    expect(r.warnings).toContain(`Section https://www.appliancepartspros.com/top-and-cabinet-parts-for-maytag-mvwx655dw1.html redirected to ${otherSection}, another model.`);
    expect(r.warnings.at(-1)).toBe("1 of 6 sections could not be read for this model, so the catalog is incomplete; nothing was saved.");

    const linked = appFetcher(MAYTAG_PAGE, model.replace(/top-and-cabinet-parts-for-maytag-mvwx655dw1/g, "top-and-cabinet-parts-for-maytag-mvwx655dw2"));
    const s = await lookupAppliancePartsPros({ brand: "Maytag", model: "MVWX655DW1" }, linked.fetcher);
    expect(s).toMatchObject({ status: "mismatch", rows: [], sourceUrl: null });
    expect(s.warnings).toEqual([`1 of 6 section links are for another model (${otherSection}); the catalog was rejected and nothing was read.`]);
    expect(linked.calls).toHaveLength(1);
  });

  it("does not query suppliers for a model with unread nameplate characters", async () => {
    const { fetcher, calls } = appFetcher(null);
    for (const r of [await lookupAppliancePartsPros({ brand: "Whirlpool", model: "WCD5090JW?" }, fetcher),
      await lookupEncompass({ brand: "Whirlpool", model: "TEF3***WD" }, fetcher)]) {
      expect(r.status).toBe("mismatch");
      expect(r.warnings[0]).toMatch(/has unread characters; read the nameplate before a lookup\.$/);
    }
    expect(calls).toEqual([]);
  });

  it("reads nothing from an Encompass redirect to another model, but keeps the same model's own path variants", async () => {
    expect(encompassModelCode("https://partstore.encompass.com/model/SMGDV45H7000EW%7CA2/0001/")).toBe("SMGDV45H7000EWA2");
    const page = fx("encompass/model-page.html");
    const moved = await lookupEncompass({ brand: "Maytag", model: "MEDC465HW0" },
      async () => ({ ok: true, status: 200, finalUrl: "https://partstore.encompass.com/model/MAYMEDC465HW1", html: page }));
    expect(moved).toMatchObject({ status: "mismatch", rows: [], sourceUrl: null });
    expect(moved.warnings).toHaveLength(2);
    expect(moved.warnings[0]).toMatch(/^Encompass redirected https:\/\/partstore\.encompass\.com\/model\/WHIMEDC465HW0 to .*MAYMEDC465HW1, which is not Maytag MEDC465HW0/);
    const slash = await lookupEncompass({ brand: "Maytag", model: "MEDC465HW0" }, async (url) => ({ ok: true, status: 200, finalUrl: `${url}/`, html: page }));
    expect(slash.status).toBe("found");
  });
});

describe("catalog completeness", () => {
  const model = fx("app/MVWX655DW1-model.html");
  const section = fx("app/MVWX655DW1-top.html");
  const TOP = "https://www.appliancepartspros.com/top-and-cabinet-parts-for-maytag-mvwx655dw1.html";
  const complete: Fetcher = async (url) =>
    ({ ok: true, status: 200, finalUrl: url.includes("search.aspx") ? MAYTAG_PAGE : url, html: url.includes("search.aspx") ? model : section });
  /** Every section loads except top-and-cabinet, which answers `status`. */
  const oneSection = (status: number): Fetcher => async (url) =>
    url === TOP ? { ok: false, status, finalUrl: url, html: "" } : complete(url);

  it("rejects a parts list when any section is blocked, missing or fails", async () => {
    for (const [status, kind] of [[403, "blocked"], [429, "blocked"], [404, "missing"], [500, "failed"], [0, "failed"]] as const) {
      const r = await lookupAppliancePartsPros({ brand: "Maytag", model: "MVWX655DW1" }, oneSection(status));
      expect(r).toMatchObject({ status: "error", rows: [], sourceUrl: null, droppedRows: 0 });
      expect(r.warnings).toContain(`Section ${kind} (HTTP ${status}): ${TOP}`);
      expect(r.visited).toHaveLength(7);
    }
  });

  it("keeps an incomplete catalog in Retries instead of saving the sections that loaded", async () => {
    const fetcher: Fetcher = async (url) =>
      url.includes("encompass") ? { ok: true, status: 200, finalUrl: url, html: "does not exist in our database" } : oneSection(403)(url);
    const r = await lookupModelBom({ brand: "Maytag", model: "MVWX655DW1" }, fetcher);
    expect(r).toMatchObject({ status: "error", winner: null });
    expect(r.attempts.map((a) => [a.supplier, a.status])).toEqual([["encompass", "not_found"], ["appliancepartspros", "error"]]);
  });

  it("rejects a catalog with more sections than one lookup reads, before fetching any", async () => {
    const calls: string[] = [];
    const r = await lookupAppliancePartsPros({ brand: "Maytag", model: "MVWX655DW1" }, async (url) => {
      calls.push(url);
      return complete(url);
    }, { maxSections: 5 });
    expect(r).toMatchObject({ status: "error", rows: [] });
    expect(r.warnings).toEqual(["The catalog lists 6 sections, more than the 5 read per lookup; it was rejected as incomplete and nothing was read."]);
    expect(calls).toHaveLength(1);
  });

  it("reads a section that loads but lists no parts as empty, not missing", async () => {
    // Cover sheets and wiring pages list no parts; ~580 verified production BOMs have such sections.
    const r = await lookupAppliancePartsPros({ brand: "Maytag", model: "MVWX655DW1" }, async (url) => {
      if (url.includes("cover-sheet")) return { ok: true, status: 200, finalUrl: url, html: "<html><h1>Maytag MVWX655DW1: Cover Sheet Parts</h1></html>" };
      return complete(url);
    });
    expect(r.status).toBe("found");
    expect(r.rows.length).toBeGreaterThan(5);
  });

  describe("Encompass pages", () => {
    const page = fx("encompass/model-page.html");
    const URL1 = "https://partstore.encompass.com/model/WHIMEDC465HW0";
    const paged = (n: number) => page.replace("</body>", `${Array.from({ length: n - 1 }, (_, i) => `<a href="/model/WHIMEDC465HW0/_/${i + 2}">${i + 2}</a>`).join("")}</body>`);
    const run = async (first: string, next: (url: string) => { ok: boolean; status: number; finalUrl: string }) => {
      const calls: string[] = [];
      const r = await lookupEncompass({ brand: "Maytag", model: "MEDC465HW0" }, async (url) => {
        calls.push(url);
        if (url === URL1) return { ok: true, status: 200, finalUrl: url, html: first };
        if (url.startsWith(`${URL1}/_/`)) return { ...next(url), html: page };
        return { ok: true, status: 200, finalUrl: url, html: "does not exist in our database" };
      });
      return { r, calls };
    };

    it("reads every listed page", async () => {
      const { r, calls } = await run(paged(3), (url) => ({ ok: true, status: 200, finalUrl: url }));
      expect(r.status).toBe("found");
      expect(calls).toEqual([URL1, `${URL1}/_/2`, `${URL1}/_/3`]);
    });

    it("rejects the catalog when a later page fails or moves to another model", async () => {
      const failed = await run(paged(3), (url) => ({ ok: !url.endsWith("/2"), status: url.endsWith("/2") ? 403 : 200, finalUrl: url }));
      expect(failed.r).toMatchObject({ status: "error", rows: [], sourceUrl: null });
      expect(failed.r.warnings).toContain(`Encompass page 2 of 3 failed (HTTP 403) for ${URL1}; the catalog is incomplete and nothing was saved.`);
      const moved = await run(paged(3), (url) => ({ ok: true, status: 200, finalUrl: url.replace("WHIMEDC465HW0", "WHIMEDC465HW1") }));
      expect(moved.r).toMatchObject({ status: "mismatch", rows: [], sourceUrl: null });
      expect(moved.r.warnings[0]).toMatch(/^Encompass page 2 of .*WHIMEDC465HW0 redirected to .*WHIMEDC465HW1\/_\/2, another model/);
    });

    it("rejects a catalog that lists more pages than one lookup reads, before fetching them", async () => {
      const { r, calls } = await run(paged(21), (url) => ({ ok: true, status: 200, finalUrl: url }));
      expect(r).toMatchObject({ status: "error", rows: [] });
      expect(r.warnings).toContain(`Encompass lists 21 pages for ${URL1}, more than the 20 read per lookup; the catalog was rejected as incomplete.`);
      expect(calls.some((u) => u.includes("/_/"))).toBe(false);
    });
  });
});
