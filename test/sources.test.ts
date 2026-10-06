import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { encompassModelUrls, encompassPageCount, isInvalidModelPage, lookupEncompass, parseEncompassPage } from "@/src/sources/encompass";
import { extractSectionLinks, lookupAppliancePartsPros, oemFromSlug, parseSectionPage } from "@/src/sources/appliancepartspros";
import { lookupModelBom } from "@/src/sources/chain";
import type { Fetcher } from "@/src/sources/types";

const fx = (p: string) => readFileSync(path.join(__dirname, "fixtures", p), "utf8");

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
    const r = await lookupModelBom({ brand: "Frigidaire", model: "FFTW4120SW1" }, fetcher);
    expect(r.status).toBe("found");
    expect(r.winner?.supplier).toBe("appliancepartspros");
    expect(r.attempts.map((a) => a.supplier)).toEqual(["encompass", "appliancepartspros"]);
  });

  it("reports error when every supplier fails on HTTP", async () => {
    const fetcher: Fetcher = async (url) => ({ ok: false, status: 403, finalUrl: url, html: "" });
    const r = await lookupModelBom({ brand: "GE", model: "GDT535PSJ2SS" }, fetcher);
    expect(r.status).toBe("error");
  });
});
