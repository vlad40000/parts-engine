import { describe, expect, it } from "vitest";
import { lgSectionLinks, lgVariationModelUrl, lookupLgVariation, parseLgVariantSection } from "@/src/sources/lg-variant";
import { lookupModelBom } from "@/src/sources/chain";
import type { Fetcher } from "@/src/sources/types";

const base = "https://www.appliancerepair.homedepot.com/Models/WT7200CW/MFGModelNumber/ABWEVUS/";
const urls = ["Outer-Case-Assembly", "Top-Cover-Assembly", "Tub-Assembly"].map((name) =>
  `${base}Sections/${name}/?ModelNum=WT7200CW&mfgModelNum=ABWEVUS`);
const page = `<html><body><h1>WT7200CW (ABWEVUS) LG Washer - Overview</h1>
  ${urls.map((u, i) => `<a href="${u}">Section ${i}</a>`).join("")}</body></html>`;
const section = (name: string) => `<html><body><h1>WT7200CW ${name} Sections</h1>
  <div>CABINET ASSEMBLY</div><div>Part #: HD8748226</div><div>Manufacturer Part #: ABJ7291961${name.includes("Outer") ? "6" : name.includes("Top") ? "7" : "8"}</div><div>$263.51</div><div>F000</div>
  <div>PCB ASSEMBLY</div><div>Part #: HD12080807</div><div>Manufacturer Part #: EBR8163430${name.includes("Outer") ? "5" : name.includes("Top") ? "6" : "7"}</div><div>$263.51</div><div>A061</div>
  <div>PUMP ASSEMBLY</div><div>Part #: HD11706439</div><div>Manufacturer Part #: 5859EA1004${name.includes("Outer") ? "P" : name.includes("Top") ? "Q" : "R"}</div><div>F080</div>
  </body></html>`;
const fetcher: Fetcher = async (url) => ({
  ok: true, status: 200, finalUrl: url, html: url === base ? page : section(url.split("/Sections/")[1] ?? "")
});
const q = { brand: "LG", model: "WT7200CW", variation: "ABWEVUS" };
describe("exact LG variation supplier BOM", () => {
  it("builds variation-specific URL and sees all three sections", () => {
    expect(lgVariationModelUrl("WT7200CW", "ABWEVUS")).toBe(base);
    expect(lgVariationModelUrl("WT7200CW/00", "ABWEVUS")).toBeNull();
    expect(lgSectionLinks(page, base, q.model, q.variation)).toEqual({ links: urls, foreign: 0 });
    expect(parseLgVariantSection(section("Outer"), "Outer").rows[0]).toMatchObject({
      mpnCanonical: "ABJ72919616", supplierPartId: "HD8748226"
    });
  });
  it("accepts only a complete variant-verified set of sections", async () => {
    const result = await lookupModelBom(q, fetcher);
    expect(result.status).toBe("found");
    expect(result.winner?.sourceUrl).toBe(base);
    expect(result.winner?.supplier).toBe("homedepot-lg-variation");
    expect(result.winner?.rows).toHaveLength(9);
    expect(result.attempts).toHaveLength(1);
  });
  it("refuses missing variation without contacting generic supplier URLs", async () => {
    const called: string[] = [];
    const result = await lookupModelBom({ brand: "LG", model: "WT7200CW" }, async (url) => {
      called.push(url); return fetcher(url);
    });
    expect(result).toMatchObject({ status: "error", winner: null });
    expect(called).toHaveLength(0);
  });
  it("refuses redirected variation and incomplete sections", async () => {
    const mismatch = await lookupLgVariation(q, async (url) => ({
      ok: true, status: 200, finalUrl: url === base ? base.replace("ABWEVUS", "ABWETUS") : url,
      html: url === base ? page : section("x")
    }));
    expect(mismatch).toMatchObject({ status: "mismatch", rows: [] });
    const missing = await lookupModelBom(q, async (url) => url === urls[1]
      ? { ok: false, status: 403, finalUrl: url, html: "" } : fetcher(url));
    expect(missing).toMatchObject({ status: "error", winner: null });
  });
  it("rejects a cross-variation section even under the correct overview", async () => {
    const foreign = page.replace(urls[2], urls[2].replace("ABWEVUS", "ABWETUS"));
    const result = await lookupLgVariation(q, async (url) => ({
      ok: true, status: 200, finalUrl: url, html: url === base ? foreign : section("x")
    }));
    expect(result).toMatchObject({ status: "mismatch", rows: [] });
  });
});
