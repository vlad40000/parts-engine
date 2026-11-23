import { beforeAll, describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { acquireAppDiagrams } from "@/src/sources/diagrams/appliancepartspros";
import { acquireEncompassDiagrams, ENCOMPASS_CALLOUT_ENDPOINT } from "@/src/sources/diagrams/encompass";
import { acquireHdVariationDiagrams, hdOverviewIdentity, hdSectionIndex, hdVariationUrl, parseHdSection } from "@/src/sources/diagrams/homedepot-variation";
import { oemPartsListAttempt, parseOemPartsListText } from "@/src/sources/diagrams/oem-parts-list";
import { finishAttempt, unreadable } from "@/src/sources/diagrams/outcome";
import { sectionKey } from "@/src/sources/diagrams/reconcile";
import type { DiagramAttempt, DiagramSection } from "@/src/sources/diagrams/types";
import { appSearchUrl } from "@/src/sources/appliancepartspros";
import { canonicalizeMpn } from "@/src/lib/mpn";
import type { Fetcher, FetchResult } from "@/src/sources/types";
import {
  DIAGRAM_CASES, FIXTURE_ROOT, loadCase, machine6613Callout10, matrixRows, runDiagramCase, type CaseResult
} from "./diagram-sources-support";

const UPDATE = process.env.UPDATE_DIAGRAM_RESULTS === "1";
const RESULTS = path.join(FIXTURE_ROOT, "results.json");
const SOURCE_ONLY = path.join(FIXTURE_ROOT, "source-only");
const sourceOnly = (name: string) => readFile(path.join(SOURCE_ONLY, name), "utf8");

const byCase = new Map<string, CaseResult>();
const attempt = (caseId: string, provider: DiagramAttempt["provider"]) => {
  const found = byCase.get(caseId)?.attempts.find((a) => a.provider === provider);
  if (!found) throw new Error(`no ${provider} attempt for ${caseId}`);
  return found;
};
const section = (a: DiagramAttempt, key: string): DiagramSection => {
  const found = a.sections.find((s) => sectionKey(s.assembly) === key);
  if (!found) throw new Error(`no ${key} in ${a.provider}`);
  return found;
};
const page = (status: number, finalUrl: string, html = ""): FetchResult => ({ ok: status >= 200 && status < 300, status, finalUrl, html });

/** Serves fixed responses; anything else is a test error, never a network call. */
function serve(responses: Record<string, FetchResult>, requested: string[] = []): Fetcher {
  return async (url) => {
    requested.push(url);
    const res = responses[url];
    if (!res) throw new Error(`unexpected request ${url}`);
    return res;
  };
}

beforeAll(async () => {
  for (const c of DIAGRAM_CASES) {
    const { manifest, fetcher, oem } = await loadCase(c);
    byCase.set(c.id, await runDiagramCase(c, fetcher, new Date(manifest.capturedAt), oem && {
      url: oem.url, status: oem.status, finalUrl: oem.finalUrl, sha256: oem.sha256, bytes: oem.bytes, extractor: oem.extractor, text: oem.text
    }));
  }
});

describe("diagram source results dataset (offline replay of captured fixtures)", () => {
  it("rebuilds results.json exactly from the fixtures", async () => {
    const results = DIAGRAM_CASES.map((c) => byCase.get(c.id)!);
    const dataset = {
      command: "npx vitest run test/diagram-sources.test.ts  (UPDATE_DIAGRAM_RESULTS=1 rewrites this file)",
      source: "test/fixtures/diagrams/<case>/manifest.json and the minimized pages it lists",
      matrix: matrixRows(results),
      machine6613: machine6613Callout10(byCase.get("maytag-mvw6230hw1")!),
      cases: results.map((r) => ({ case: r.case, capturedAt: r.capturedAt, attempts: r.attempts, contrast: r.contrast, reconciliation: r.reconciliation }))
    };
    const text = `${JSON.stringify(dataset, null, 2)}\n`;
    if (UPDATE) await writeFile(RESULTS, text);
    expect(text).toBe(await readFile(RESULTS, "utf8"));
  });

  it("records an outcome with a reason for every attempted model and source", () => {
    const rows = matrixRows(DIAGRAM_CASES.map((c) => byCase.get(c.id)!));
    expect(rows.map((r) => [r.case, r.provider, r.outcome])).toEqual([
      ["maytag-mvw6230hw1", "appliancepartspros", "complete"],
      ["maytag-mvw6230hw1", "encompass", "blocked"],
      ["maytag-mvw6230hw1", "oem-parts-list", "complete"],
      ["ge-gss25wgtabb", "appliancepartspros", "complete"],
      ["ge-gss25wgtabb", "encompass", "blocked"],
      ["kenmore-790-91319013", "appliancepartspros", "blocked"],
      ["kenmore-790-91319013", "encompass", "blocked"],
      ["lg-wt7200cw-abwevus", "homedepot", "blocked"],
      ["lg-wt7200cw-abwevus", "appliancepartspros", "blocked"],
      ["lg-wt7200cw-abwevus", "encompass", "blocked"]
    ]);
    for (const r of rows) expect(r.reason.length).toBeGreaterThan(20);
  });
});

describe("primary case: Maytag MVW6230HW1, machine 6613", () => {
  it("reads every AppliancePartsPros assembly for the exact model, with drawings and string callouts", () => {
    const app = attempt("maytag-mvw6230hw1", "appliancepartspros");
    expect(app).toMatchObject({ outcome: "complete", expectedSections: 6, retrievedSections: 6, sourceUrl: "https://www.appliancepartspros.com/parts-for-whirlpool-mvw6230hw1.html" });
    const top = section(app, "TOPANDCABINET");
    expect(top.assembly).toBe("02 - Top And Cabinet");
    expect(top.diagramUrl).toMatch(/^https:\/\/[^/]+\/diagram\/\d+_\d+\.gif$/);
    expect(top.callouts.find((r) => r.callout === "10")).toMatchObject({ supplierMpn: "W11543994", mpnKey: "W11543994", supplierPartId: "AP7019156" });
    expect(top.callouts.every((r) => typeof r.callout === "string")).toBe(true);
    expect(top.callouts.map((r) => r.callout)).toEqual(expect.arrayContaining(["9", "9A", "30", "30A"]));
  });

  it("reads the Maytag parts list W11497934 Rev. B and ties drawing page, key page and callout 10 together", () => {
    const oem = attempt("maytag-mvw6230hw1", "oem-parts-list");
    expect(oem.identity).toBe("cover of W11497934 Rev. B (04/06/2021) names MVW6230HW1 (White)");
    expect(oem).toMatchObject({ outcome: "complete", expectedSections: 5, retrievedSections: 5 });
    const top = section(oem, "TOPANDCABINET");
    expect(top.diagramUrl).toBe("https://assets.ajmadison.com/ajmadison/itemdocs/repair-parts-list-w11497934-revb.pdf#page=2");
    expect(top.sourcePageUrl).toBe("https://assets.ajmadison.com/ajmadison/itemdocs/repair-parts-list-w11497934-revb.pdf#page=3");
    expect(top.callouts.filter((r) => r.callout === "10")).toEqual([
      { callout: "10", supplierMpn: "W11479877", mpnKey: "W11479877", description: "Control Unit Assembly, Machine and Motor", supplierPartId: null, variantLabel: null }
    ]);
    // One callout, one row per finish; the list does not pick a finish for the machine.
    expect(top.callouts.filter((r) => r.callout === "9").map((r) => [r.supplierMpn, r.variantLabel])).toEqual([["W11126896", "White"], ["W11126897", "Chrome Shadow"]]);
    expect(new Set(top.callouts.map((r) => r.callout)).size).toBe(40);
  });

  it("keeps the catalog, supplier, observed and replacement numbers for section 02 callout 10 as separate evidence", () => {
    const evidence = machine6613Callout10(byCase.get("maytag-mvw6230hw1")!);
    expect(evidence.section).toBe("TOP AND CABINET PARTS");
    expect(evidence.numbers.map((n) => [n.role, n.mpn])).toEqual([
      ["catalog", "W11479877"], ["supplier_listed", "W11543994"], ["observed", "W11538088"], ["replacement", "W11543994"]
    ]);
    for (const n of evidence.numbers) expect(n.mpnKey).toBe(canonicalizeMpn(n.mpn));
    const top = byCase.get("maytag-mvw6230hw1")!.reconciliation!.sections.find((s) => s.section === "TOPANDCABINET")!;
    expect(top.differentNumber).toContainEqual({ callout: "10", catalog: ["W11479877"], supplier: ["W11543994"] });
    // The supplier lists callout 1 (literature) but its links do not end in an OEM number: unread, not absent.
    expect(top).toMatchObject({ catalogCallouts: 40, missingFromSupplier: [], unreadAtSupplier: ["1"], notInCatalog: [] });
  });

  it("compares the unillustrated optional parts by number without collapsing WP aliases", () => {
    const optional = byCase.get("maytag-mvw6230hw1")!.reconciliation!.sections.find((s) => s.section === "OPTIONALPARTSNOTINCLUDED")!;
    expect(section(attempt("maytag-mvw6230hw1", "oem-parts-list"), "OPTIONALPARTSNOTINCLUDED")).toMatchObject({ illustrated: false, diagramUrl: null, callouts: [] });
    expect(optional.unillustrated?.catalogOnly).toContain("285195");
    expect(optional.unillustrated?.supplierOnly).toContain("WP285195");
    expect(optional.unillustrated?.shared.length).toBe(27);
  });

  it("records Encompass as blocked with the refusal for each manufacturer code tried", () => {
    const enc = attempt("maytag-mvw6230hw1", "encompass");
    expect(enc).toMatchObject({ outcome: "blocked", sections: [], sourceUrl: null });
    expect(enc.fetches.map((f) => [f.url, f.status, f.outcome])).toEqual([
      ["https://partstore.encompass.com/model/WHIMVW6230HW1", 403, "blocked"],
      ["https://partstore.encompass.com/model/MAYMVW6230HW1", 403, "blocked"]
    ]);
  });
});

describe("exact identity", () => {
  const landing = async () => {
    const { fetcher } = await loadCase(DIAGRAM_CASES[0]);
    return fetcher(appSearchUrl("MVW6230HW1"));
  };

  it("refuses an adjacent revision even when the supplier lands on its neighbour", async () => {
    const neighbour = await landing();
    const requested: string[] = [];
    const result = await acquireAppDiagrams({ brand: "Maytag", model: "MVW6230HW0" }, serve({ [appSearchUrl("MVW6230HW0")]: neighbour }, requested));
    expect(result).toMatchObject({ outcome: "blocked", sections: [], retrievedRows: 0 });
    expect(result.reason).toContain("parts-for-whirlpool-mvw6230hw1.html");
    expect(requested).toHaveLength(1);

    const ge = byCase.get("ge-gss25wgtabb")!;
    const { fetcher } = await loadCase(ge.case);
    const geLanding = await fetcher(appSearchUrl("GSS25WGTABB"));
    const shorter = await acquireAppDiagrams({ brand: "GE", model: "GSS25WGTAB" }, serve({ [appSearchUrl("GSS25WGTAB")]: geLanding }));
    expect(shorter.outcome).toBe("blocked");
  });

  it("refuses a parts list for a sibling revision but accepts the other model the cover names", async () => {
    const { oem } = await loadCase(DIAGRAM_CASES[0]);
    const list = parseOemPartsListText(oem!.text);
    const src = { pdfUrl: oem!.url, retrievedAt: "2026-11-23T00:00:00.000Z", fetches: [] };
    expect(list.models).toEqual([{ model: "MVW6230HW1", label: "White" }, { model: "MVW6230HC1", label: "Chrome Shadow" }]);
    const sibling = oemPartsListAttempt({ brand: "Maytag", model: "MVW6230HW0" }, list, src);
    expect(sibling).toMatchObject({ outcome: "blocked", sections: [] });
    expect(sibling.reason).toContain("covers MVW6230HW1, MVW6230HC1, not Maytag MVW6230HW0");
    expect(oemPartsListAttempt({ brand: "Maytag", model: "MVW6230HC1" }, list, src).outcome).toBe("complete");
  });

  it("keeps nothing when a listed section loads another model's page", async () => {
    const { fetcher } = await loadCase(DIAGRAM_CASES[0]);
    const ge = await loadCase(byCase.get("ge-gss25wgtabb")!.case);
    const foreign = await ge.fetcher("https://www.appliancepartspros.com/freezer-door-parts-for-ge-gss25wgtabb.html");
    const mixed: Fetcher = async (url) => url.includes("03-console") ? { ...foreign, finalUrl: url } : fetcher(url);
    const result = await acquireAppDiagrams({ brand: "Maytag", model: "MVW6230HW1" }, mixed);
    expect(result).toMatchObject({ outcome: "blocked", sections: [] });
    expect(result.reason).toContain("freezer-door-parts-for-ge-gss25wgtabb.html, not Maytag MVW6230HW1");
  });

  it("does not yet confirm Kenmore 790.91319013: the shared section guard refuses APP's alias heading", () => {
    // Pinned as found 2026-11-23. The same appSectionIdentity guard runs in the BOM lookup; changing it is a separate, reviewed change.
    const kenmore = attempt("kenmore-790-91319013", "appliancepartspros");
    expect(kenmore).toMatchObject({ outcome: "blocked", expectedSections: 4, sections: [] });
    expect(kenmore.reason).toContain("Kenmore 790.91319013 (79091319013, 790 91319013)");
  });
});

describe("historical fleet case: GE GSS25WGTABB, machine 2121 (SOLD)", () => {
  it("reads all nine assemblies with GE's sparse callout numbers kept as printed", () => {
    const ge = attempt("ge-gss25wgtabb", "appliancepartspros");
    expect(ge).toMatchObject({ outcome: "complete", expectedSections: 9, retrievedSections: 9, retrievedRows: 234 });
    expect(matrixRows([byCase.get("ge-gss25wgtabb")!])[0]).toMatchObject({ machine: "2121", fleetStatus: "SOLD" });
    expect(section(ge, "EVAPORATORINSTRUCTIONS").callouts).toEqual([
      expect.objectContaining({ callout: "228", supplierMpn: "WR87X29147" })
    ]);
    expect(section(ge, "FREEZERDOOR").callouts.map((r) => r.callout)).toEqual(expect.arrayContaining(["6", "900", "911"]));
  });

  it("keeps one part number at several callouts and several part numbers at one callout", () => {
    const ice = section(attempt("ge-gss25wgtabb", "appliancepartspros"), "ICEMAKERDISPENSER");
    expect(ice.callouts.filter((r) => r.mpnKey === "WR62X26536").map((r) => r.callout)).toEqual(["379", "380", "381", "382", "384", "385"]);
    expect(ice.callouts.filter((r) => r.callout === "328").map((r) => r.supplierMpn)).toEqual(["WR2X4143", "WR2X4561", "WR17X10703"]);
  });
});

describe("manufacturer variation: LG WT7200CW ABWEVUS", () => {
  const overviewUrl = hdVariationUrl("WT7200CW", "ABWEVUS");
  const q = { brand: "LG", model: "WT7200CW", variation: "ABWEVUS" };
  let overview = "";
  let outerCase = "";
  let otherVariation = "";
  let index: ReturnType<typeof hdSectionIndex> = [];
  beforeAll(async () => {
    [overview, outerCase, otherVariation] = await Promise.all([
      sourceOnly("hd-wt7200cw-abwevus-overview.html"), sourceOnly("hd-wt7200cw-abwevus-outer-case-assembly.html"), sourceOnly("hd-wt7200cw-abwetus-overview.html")
    ]);
    index = hdSectionIndex(q, overview, overviewUrl);
  });

  it("records the live probe as blocked by every provider, and evaluates no identity on an unread page", () => {
    const lg = byCase.get("lg-wt7200cw-abwevus")!;
    expect(lg.attempts.map((a) => [a.provider, a.outcome])).toEqual([["homedepot", "blocked"], ["appliancepartspros", "blocked"], ["encompass", "blocked"]]);
    expect(attempt("lg-wt7200cw-abwevus", "appliancepartspros").reason).toContain("no manufacturer variation");
    expect(lg.contrast).toMatchObject({ status: 403, unread: "HTTP 403 access refused", asIntended: null, asContrast: null });
  });

  it("accepts the overview only for the variation it names", () => {
    expect(hdOverviewIdentity(q, overviewUrl, overview)).toEqual({ status: "ok" });
    const etus = hdVariationUrl("WT7200CW", "ABWETUS");
    expect(hdOverviewIdentity(q, etus, otherVariation)).toMatchObject({ status: "mismatch" });
    // Served at the ABWEVUS address, the ABWETUS page is still refused by its own canonical link and heading.
    expect(hdOverviewIdentity(q, overviewUrl, otherVariation)).toMatchObject({ status: "mismatch" });
    expect(hdOverviewIdentity({ ...q, variation: "ABWETUS" }, etus, otherVariation)).toEqual({ status: "ok" });
    // An empty body (a refused request) confirms nothing, whatever its URL.
    expect(hdOverviewIdentity(q, overviewUrl, "")).toEqual({ status: "unknown" });
  });

  it("links each assembly to the drawing its own variation uses", () => {
    expect(index.map((e) => [e.title, e.drawingKey, e.foreign])).toEqual([
      ["Outer Case Assembly", "EA0269AF068E0B4DBFF49B04AA7B74F8FF73E086", false],
      ["Top Cover Assembly", "578D3CAD07323DB0ED02F30C249EDB1CF4949E92", false],
      ["Tub Assembly", "B9E1FCC4205FEA5FB6A658AF9F40A109553D085F", false]
    ]);
    const etus = hdSectionIndex({ ...q, variation: "ABWETUS" }, otherVariation, hdVariationUrl("WT7200CW", "ABWETUS"));
    expect(etus.map((e) => e.drawingKey)).toEqual([index[0].drawingKey, "4E8A08BF70DF397B247DEBA6F243374E98CAE6D0", index[2].drawingKey]);
  });

  it("parses LG location callouts, keeping repeated callouts and dropping only exact repeats", () => {
    const parsed = parseHdSection(outerCase, index[0].url);
    expect(parsed).toMatchObject({
      assembly: "Outer Case Assembly", drawingKey: "EA0269AF068E0B4DBFF49B04AA7B74F8FF73E086", duplicateRows: 1, unreadRows: [],
      diagramUrl: "https://www.appliancerepair.homedepot.com/Schematics/LG/EA0269AF068E0B4DBFF49B04AA7B74F8FF73E086.gif"
    });
    expect(parsed.callouts).toHaveLength(19);
    expect(parsed.callouts.filter((r) => r.callout === "F032").map((r) => [r.supplierMpn, r.supplierPartId])).toEqual([["4930EA3002A", "HD3524200"], ["MEG64858801", "HD12081841"]]);
    expect(parsed.callouts.filter((r) => r.callout === "F018")).toHaveLength(1);
  });

  it("reports an access failure part-way as partial and stops asking that host", async () => {
    const requested: string[] = [];
    const result = await acquireHdVariationDiagrams(q, serve({
      [overviewUrl]: page(200, overviewUrl, overview),
      [index[0].url]: page(200, index[0].url, outerCase),
      [index[1].url]: page(429, index[1].url)
    }, requested), { now: () => new Date("2026-11-23T16:38:00Z") });
    expect(result).toMatchObject({ outcome: "partial", expectedSections: 3, retrievedSections: 1, retrievedRows: 19 });
    expect(result.missing).toEqual([
      "Top Cover Assembly: HTTP 429 rate limited",
      "Tub Assembly: not requested after HTTP 429 rate limited from the host"
    ]);
    expect(requested).toHaveLength(3);
  });

  it("reports missing section pages as partial", async () => {
    const result = await acquireHdVariationDiagrams(q, serve({
      [overviewUrl]: page(200, overviewUrl, overview),
      [index[0].url]: page(200, index[0].url, outerCase),
      [index[1].url]: page(404, index[1].url),
      [index[2].url]: page(404, index[2].url)
    }));
    expect(result.outcome).toBe("partial");
    expect(result.missing).toEqual(["Top Cover Assembly: HTTP 404 missing page", "Tub Assembly: HTTP 404 missing page"]);
  });

  it("keeps nothing when a section shows another drawing, links another variation, or the overview names another variation", async () => {
    const wrongDrawing = await acquireHdVariationDiagrams(q, serve({
      [overviewUrl]: page(200, overviewUrl, overview),
      [index[0].url]: page(200, index[0].url, outerCase),
      [index[1].url]: page(200, index[1].url, outerCase)
    }));
    expect(wrongDrawing).toMatchObject({ outcome: "blocked", sections: [] });
    expect(wrongDrawing.reason).toContain("not 578D3CAD07323DB0ED02F30C249EDB1CF4949E92");

    const crossLinked = overview.replace("MFGModelNumber/ABWEVUS/Sections/Tub-Assembly", "MFGModelNumber/ABWETUS/Sections/Tub-Assembly");
    const requested: string[] = [];
    const foreign = await acquireHdVariationDiagrams(q, serve({ [overviewUrl]: page(200, overviewUrl, crossLinked) }, requested));
    expect(foreign).toMatchObject({ outcome: "blocked", sections: [] });
    expect(foreign.reason).toContain("1 of 3 assembly links name another model or variation");
    expect(requested).toEqual([overviewUrl]);

    const redirected = await acquireHdVariationDiagrams(q, serve({ [overviewUrl]: page(200, hdVariationUrl("WT7200CW", "ABWETUS"), otherVariation) }));
    expect(redirected).toMatchObject({ outcome: "blocked", identity: expect.stringContaining("mismatch") });
  });

  it("requires a variation before contacting the supplier", async () => {
    const requested: string[] = [];
    const result = await acquireHdVariationDiagrams({ brand: "LG", model: "WT7200CW" }, serve({}, requested));
    expect(result.outcome).toBe("blocked");
    expect(requested).toEqual([]);
  });
});

describe("Encompass exploded view (source-only capture)", () => {
  const modelUrl = "https://partstore.encompass.com/model/WHIMVW6230HW1";
  const explodedUrl = "https://partstore.encompass.com/Exploded-View-Assembly/WHI/2619720/MVW6230HW1";

  it("lists every assembly drawing but reports the callouts it cannot read as partial", async () => {
    const [model, exploded] = await Promise.all([sourceOnly("encompass-partstore-whimvw6230hw1.html"), sourceOnly("encompass-exploded-view-mvw6230hw1.html")]);
    const result = await acquireEncompassDiagrams({ brand: "Maytag", model: "MVW6230HW1" }, serve({
      [modelUrl]: page(200, modelUrl, model), [explodedUrl]: page(200, explodedUrl, exploded)
    }));
    expect(result).toMatchObject({ outcome: "partial", expectedSections: 6, retrievedSections: 6, retrievedRows: 0, sourceUrl: explodedUrl });
    expect(result.sections.map((s) => s.assembly)).toEqual([
      "01 - COVER SHEET", "02 - TOP AND CABINET PARTS", "03 - CONSOLE PARTS", "04 - BASKET AND TUB PARTS",
      "05 - GEARCASE, MOTOR AND PUMP PARTS", "06 - OPTIONAL PARTS (NOT INCLUDED)"
    ]);
    expect(result.sections.every((s) => /^https:\/\/cdn\.datamanager\.arinet\.com\/image\/WHI\/[0-9a-f-]+\/Small$/.test(s.diagramUrl ?? ""))).toBe(true);
    expect(result.missing[0]).toContain(ENCOMPASS_CALLOUT_ENDPOINT);
    expect(sectionKey(result.sections[1].assembly)).toBe("TOPANDCABINET");
  });

  it("refuses an exploded view that is not this exact model", async () => {
    const exploded = await sourceOnly("encompass-exploded-view-mvw6230hw1.html");
    const model = await sourceOnly("encompass-partstore-whimvw6230hw1.html");
    const url = "https://partstore.encompass.com/model/WHIMVW6230HW0";
    const result = await acquireEncompassDiagrams({ brand: "Maytag", model: "MVW6230HW0" }, serve({
      [url]: page(200, url, model), "https://partstore.encompass.com/model/MAYMVW6230HW0": page(404, "https://partstore.encompass.com/model/MAYMVW6230HW0"),
      [explodedUrl]: page(200, explodedUrl, exploded)
    }));
    expect(result).toMatchObject({ outcome: "blocked", sections: [] });
  });
});

describe("completeness and access outcomes", () => {
  const q = { brand: "Maytag", model: "MVW6230HW1" };
  const one: DiagramSection = { assembly: "A", sourcePageUrl: "https://x/a", diagramUrl: null, illustrated: false, callouts: [], uncalloutedRows: [], duplicateRows: 0, unreadRows: [] };
  const draft = { provider: "appliancepartspros" as const, query: q, retrievedAt: "2026-11-23T00:00:00.000Z", sourceUrl: "https://x", identity: "test", fetches: [] };

  it("is complete only when every published section was read", () => {
    expect(finishAttempt({ ...draft, expectedSections: 1, sections: [one], missing: [] }).outcome).toBe("complete");
    expect(finishAttempt({ ...draft, expectedSections: 2, sections: [one], missing: ["B: HTTP 404 missing page"] })).toMatchObject({ outcome: "partial", reason: expect.stringContaining("B: HTTP 404") });
    expect(finishAttempt({ ...draft, expectedSections: null, sections: [one], missing: [] }).outcome).toBe("partial");
    expect(finishAttempt({ ...draft, expectedSections: 2, sections: [], missing: ["A: HTTP 403 access refused"] })).toMatchObject({ outcome: "blocked", sourceUrl: null });
    expect(finishAttempt({ ...draft, expectedSections: 1, sections: [one], missing: [], blocked: "identity" })).toMatchObject({ outcome: "blocked", sections: [] });
  });

  it("classifies refusals, rate limits, missing pages, network failures and challenge pages", () => {
    expect(unreadable(page(200, "https://x", "<html>ok</html>"))).toBeNull();
    expect(unreadable(page(403, "https://x"))).toEqual({ outcome: "blocked", note: "HTTP 403 access refused" });
    expect(unreadable(page(429, "https://x"))).toEqual({ outcome: "blocked", note: "HTTP 429 rate limited" });
    expect(unreadable(page(404, "https://x"))).toEqual({ outcome: "missing", note: "HTTP 404 missing page" });
    expect(unreadable({ ok: false, status: 0, finalUrl: "https://x", html: "timeout" })).toEqual({ outcome: "failed", note: "no response (timeout)" });
    expect(unreadable(page(200, "https://x", "<title>Just a moment...</title>"))).toEqual({ outcome: "blocked", note: "HTTP 200 bot-check challenge" });
  });

  it("marks a parts list partial when a drawing has no key page or the key skips an illustration number", async () => {
    const { oem } = await loadCase(DIAGRAM_CASES[0]);
    const pages = oem!.text.split("\f");
    const consoleKey = pages.findIndex((p, i) => i > 0 && p.includes("CONSOLE PARTS") && p.includes("Illus."));
    const withoutKey = pages.filter((_, i) => i !== consoleKey).join("\f");
    const src = { pdfUrl: oem!.url, retrievedAt: "2026-11-23T00:00:00.000Z", fetches: [] };
    const noKey = oemPartsListAttempt(q, parseOemPartsListText(withoutKey), src);
    expect(noKey).toMatchObject({ outcome: "partial", expectedSections: 5, retrievedSections: 4 });
    expect(noKey.missing).toEqual(["CONSOLE PARTS: drawing on page 4 has no parts key"]);

    const skipped = oemPartsListAttempt(q, parseOemPartsListText(oem!.text.replace("\n13 3400076 Screw\n", "\n")), src);
    expect(skipped.outcome).toBe("partial");
    expect(skipped.missing).toEqual(["TOP AND CABINET PARTS: Illus. No. 13 not in the parts key"]);
  });
});

describe("part integrity", () => {
  it("keeps supplier text and derives the D1 key separately, never stripping WP prefixes or merging numbers", () => {
    const top = section(attempt("maytag-mvw6230hw1", "appliancepartspros"), "TOPANDCABINET");
    expect(top.callouts.find((r) => r.callout === "11")).toMatchObject({ supplierMpn: "WP693995", mpnKey: "WP693995" });
    const oemTop = section(attempt("maytag-mvw6230hw1", "oem-parts-list"), "TOPANDCABINET");
    expect(oemTop.callouts.find((r) => r.callout === "11")).toMatchObject({ supplierMpn: "693995", mpnKey: "693995" });
    expect(top.callouts.filter((r) => r.mpnKey === "W11381327").map((r) => r.callout)).toEqual(["30", "30A"]);
    expect(top.unreadRows.map((r) => [r.callout, r.supplierPartId])).toEqual([["1A", "AP7478415"], ["1", "AP7997642"]]);
    expect(top.uncalloutedRows.map((r) => r.supplierMpn)).toEqual(["W10501250"]);
  });
});
