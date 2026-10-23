import { describe, expect, it } from "vitest";
import { encompassModelUrls, lookupEncompass } from "@/src/sources/encompass";
import type { Fetcher } from "@/src/sources/types";

const expected = "https://encompass.com/model/ZENWM2688HWM";
const legacy = "https://partstore.encompass.com/model/LGEWM2688HWM";
const query = { brand: "LG", model: "WM2688HWM" };

/**
 * Shape of an Encompass Next.js page that declares 111 entries.
 * The parser must recover every part from embedded HTML, not save the
 * first ten parts shown by the table/pager.
 */
function modelHtml(partCount = 111, namedModel = "WM2688HWM"): string {
  const parts = Array.from({ length: partCount }, (_, i) => ({
    partNumber: `ABC${String(i).padStart(5, "0")}`,
    partDescription: `LG assembly ${i}`,
    location: `A${i}`,
    reportPartPrice: "12.95",
    allowPurchase: "Y"
  }));
  const payload = JSON.stringify({ modelNumber: namedModel, parts });
  return `<!doctype html><html><head><link rel="canonical" href="${expected}"></head><body>
    <h1>${namedModel} LG replacement parts</h1>
    <p>Showing 1 to 10 of 111 entries</p>
    <script>self.__next_f.push([1,${JSON.stringify(payload)}])</script>
  </body></html>`;
}

describe("LG Encompass ZEN model path", () => {
  it("tries the verified ZEN model on encompass.com before legacy PartStore LGE, without changing other brands", () => {
    expect(encompassModelUrls(query.brand, query.model)).toEqual([expected, legacy]);
    expect(encompassModelUrls("Maytag", "MVWX655DW1")).toEqual([
      "https://partstore.encompass.com/model/WHIMVWX655DW1",
      "https://partstore.encompass.com/model/MAYMVWX655DW1"
    ]);
    expect(encompassModelUrls("LG", "WM2688HWM/00").slice(0, 3)).toEqual([
      "https://encompass.com/model/ZENWM2688HWM%7C00",
      "https://encompass.com/model/ZENWM2688HWM%7C00/0001/",
      "https://encompass.com/model/ZENWM2688HWM00"
    ]);
  });

  it("accepts a complete identity-verified 111-part ZEN catalog", async () => {
    const visited: string[] = [];
    const fetcher: Fetcher = async (url) => {
      visited.push(url);
      return { ok: true, status: 200, finalUrl: url, html: modelHtml() };
    };
    const result = await lookupEncompass(query, fetcher);
    expect(visited).toEqual([expected]);
    expect(result.status).toBe("found");
    expect(result.sourceUrl).toBe(expected);
    expect(result.rows).toHaveLength(111);
    expect(result.rows[0]).toMatchObject({ mpnCanonical: "ABC00000", diagramId: "A0" });
  });

  it("tries the legacy LGE route if the canonical ZEN path is unavailable", async () => {
    const calls: string[] = [];
    const fetcher: Fetcher = async (url) => {
      calls.push(url);
      return url === expected
        ? { ok: false, status: 404, finalUrl: url, html: "" }
        : { ok: true, status: 200, finalUrl: url, html: modelHtml() };
    };
    const result = await lookupEncompass(query, fetcher);
    expect(calls).toEqual([expected, legacy]);
    expect(result.status).toBe("found");
  });

  it("rejects only-first-page data when the source declares 111 parts", async () => {
    const result = await lookupEncompass(query, async (url) => url === expected
      ? { ok: true, status: 200, finalUrl: url, html: modelHtml(10) }
      : { ok: false, status: 403, finalUrl: url, html: "" });
    expect(result).toMatchObject({ status: "error", rows: [], sourceUrl: null });
    expect(result.warnings.join(" ")).toContain("rejected as incomplete");
  });

  it("rejects a wrong-model page even when it uses the requested ZEN URL", async () => {
    const result = await lookupEncompass(query, async (url) => url === expected
      ? { ok: true, status: 200, finalUrl: url, html: modelHtml(111, "WM2688HNM") }
      : { ok: false, status: 403, finalUrl: url, html: "" });
    expect(result).toMatchObject({ status: "mismatch", rows: [], sourceUrl: null });
    expect(result.warnings.join(" ")).toContain("WM2688HNM");
  });

  it("reports an access failure if both public paths refuse automated requests", async () => {
    const result = await lookupEncompass(query, async (url) =>
      ({ ok: false, status: 403, finalUrl: url, html: "" }));
    expect(result).toMatchObject({ status: "error", rows: [], sourceUrl: null });
    expect(result.visited).toEqual([expected, legacy]);
  });
});
