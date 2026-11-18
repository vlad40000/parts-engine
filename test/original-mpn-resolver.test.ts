import { describe, expect, it } from "vitest";
import type { OemEvidence, OriginalMpnEvidence, OemSource } from "@/src/lib/oem-evidence";
import { resolveOriginalMpn } from "@/src/lib/original-mpn-resolver";
import { GE_CONTROL, GE_EVIDENCE, GE_MARKING, SYNTHETIC_BREAK, SYNTHETIC_CONTROL } from "./fixtures/original-mpn-evidence";

const donor = { ...SYNTHETIC_CONTROL, machineNo: "fixture-1", serial: "SL199999Q", asOfYear: 2026 };
const source: OemSource = { id: "synthetic-build-date", kind: "oem_serial_document", url: "https://example.invalid/build-date" };
function documented(mpn: string, notes: string[], override: Partial<OriginalMpnEvidence> = {}): OriginalMpnEvidence {
  return { kind: "original", scope: SYNTHETIC_CONTROL, mpn, source, applicability: { validated: true, notes }, ...override };
}

describe("serial-aware factory MPN prediction", () => {
  it("resolves different originals on the same exact model when the serial crosses a documented break", () => {
    expect(resolveOriginalMpn(donor, SYNTHETIC_BREAK).factoryOriginalPrediction).toMatchObject({
      status: "serial_supported", resolvedMpnCanonical: "TESTA", candidates: [{ mpnCanonical: "TESTA" }]
    });
    const later = resolveOriginalMpn({ ...donor, serial: "SL200000Q" }, SYNTHETIC_BREAK);
    expect(later.factoryOriginalPrediction).toMatchObject({
      status: "serial_supported", resolvedMpnCanonical: "TESTB", candidates: [{ mpnCanonical: "TESTB" }]
    });
    expect(later.productionDate.candidates.map((c) => c.year)).toEqual([1982, 1994, 2006, 2018]);
  });

  it.each(["", "SL", "SL199999", "SL199999Z", "SM199999Q"])("returns unresolved for non-comparable serial '%s'", (serial) => {
    expect(resolveOriginalMpn({ ...donor, serial }, SYNTHETIC_BREAK).factoryOriginalPrediction).toMatchObject({
      status: "unresolved", resolvedMpnCanonical: null
    });
  });

  it("compares full model, brand, and slot without collapsing variations or punctuation", () => {
    for (const input of [
      { ...donor, model: "EXAMPLE" }, { ...donor, model: "EXAMPLE.02" },
      { ...donor, model: "EXAMPLE/01" }, { ...donor, model: "EXAMPLE01" },
      { ...donor, brand: "Hotpoint" }, { ...donor, component: "control-2" }
    ]) {
      expect(resolveOriginalMpn(input, SYNTHETIC_BREAK).factoryOriginalPrediction.status).toBe("unresolved");
    }
    expect(resolveOriginalMpn({ ...donor, model: " example.01 " }, SYNTHETIC_BREAK).factoryOriginalPrediction.status)
      .toBe("serial_supported");
  });

  it("returns conflict when plausible years point to different originals or only some are covered", () => {
    const early = documented("TEST-A", ["Built before 2010"]);
    const late = documented("TEST-B", ["Built starting with 2010"]);
    expect(resolveOriginalMpn(donor, [early, late]).factoryOriginalPrediction).toMatchObject({
      status: "conflict", resolvedMpnCanonical: null, candidates: [{ mpnCanonical: "TESTA" }, { mpnCanonical: "TESTB" }]
    });
    expect(resolveOriginalMpn(donor, [late]).factoryOriginalPrediction.status).toBe("conflict");
  });

  it("can support the same original across every plausible year using two matching rules", () => {
    const claims = [documented("TEST-A", ["Built before 2010"]), documented(" test a ", ["Built starting with 2010"])];
    const prediction = resolveOriginalMpn(donor, claims).factoryOriginalPrediction;
    expect(prediction).toMatchObject({ status: "serial_supported", resolvedMpnCanonical: "TESTA" });
    expect(prediction.candidates).toHaveLength(1);
    expect(resolveOriginalMpn(donor, claims)).toEqual(resolveOriginalMpn(donor, [...claims].reverse()));
  });

  it("does not resolve across a precision gap or an overlapping, competing exact rule", () => {
    const claims = [documented("TEST-A", ["Through SL200000Q"]), documented("TEST-B", ["Built after 2018-09-15"])];
    expect(resolveOriginalMpn(donor, claims).factoryOriginalPrediction.status).toBe("conflict");
    expect(resolveOriginalMpn(donor, [documented("TEST-B", ["Built after 2018-09-15"])]).factoryOriginalPrediction.status)
      .toBe("conflict");
  });

  it("requires every documented condition on the row and refuses a malformed qualifier", () => {
    const serialNote = "Before SL200000Q";
    expect(resolveOriginalMpn(donor, [documented("TEST-A", [serialNote, "Revision /01"])]).factoryOriginalPrediction.status)
      .toBe("unresolved");
    const input = { ...donor, revision: "/01" };
    expect(resolveOriginalMpn(input, [documented("TEST-A", [serialNote, "Revision /01"])]).factoryOriginalPrediction.status)
      .toBe("serial_supported");
    expect(resolveOriginalMpn(input, [documented("TEST-A", [serialNote, "Only with updated harness"])]).factoryOriginalPrediction.status)
      .toBe("unresolved");
  });

  it("ignores invalid notes and mismatched scopes without destabilizing a valid decision", () => {
    const additional = [
      documented("TEST-C", ["After the change"]),
      documented("TEST-C", ["After serial SL2000"], { source: { ...source, kind: "oem_model_diagram" } }),
      documented("TEST-C", ["Through SL200000Q"], { scope: { ...SYNTHETIC_CONTROL, model: "EXAMPLE.02" } })
    ];
    expect(resolveOriginalMpn(donor, [...SYNTHETIC_BREAK, ...additional])).toEqual(resolveOriginalMpn(donor, SYNTHETIC_BREAK));
  });

  it("uses reviewed, serial-specific OEM evidence over a catalog row with no applicability", () => {
    const catalog: OemEvidence = {
      kind: "original", scope: SYNTHETIC_CONTROL, mpn: "TEST-C", source: { ...source, kind: "oem_model_diagram" }
    };
    expect(resolveOriginalMpn(donor, [...SYNTHETIC_BREAK, catalog]).factoryOriginalPrediction).toMatchObject({
      status: "serial_supported", resolvedMpnCanonical: "TESTA"
    });
  });

  it("requires a reviewed OEM applicability rule and never uses a capture date as a build date", () => {
    const archived: OemSource = { ...source, kind: "oem_historical_bom", capturedOn: "2018-09-19" };
    const notes = ["Through SL200000Q"];
    expect(resolveOriginalMpn(donor, [documented("TEST-A", notes, { source: { ...archived, kind: "archive_capture" } })])
      .factoryOriginalPrediction.status).toBe("unresolved");
    expect(resolveOriginalMpn(donor, [documented("TEST-A", notes, { source: archived, applicability: { notes, validated: false } })])
      .factoryOriginalPrediction.status).toBe("candidate");
    const validated = resolveOriginalMpn(donor, [documented("TEST-A", notes, { source: archived })]);
    expect(validated.factoryOriginalPrediction.status).toBe("serial_supported");
    expect(validated.productionDate.candidates.map((c) => c.year)).toEqual([1982, 1994, 2006, 2018]);
    expect(resolveOriginalMpn(donor, [documented("TEST-A", notes, { source: { ...source, kind: "reseller" } })])
      .factoryOriginalPrediction.status).toBe("candidate");
  });

  it("does not let copies of an upstream claim outvote a competing rule", () => {
    const a = documented("TEST-A", ["Through SL200000Q"]);
    const copy = { ...a, source: { ...source, id: "synthetic-copy", upstreamId: source.id } };
    const b = documented("TEST-B", ["Through SL200000Q"], { source: { ...source, id: "separate-bulletin" } });
    const prediction = resolveOriginalMpn(donor, [a, copy, b]).factoryOriginalPrediction;
    expect(prediction.status).toBe("conflict");
  });
});

describe("GE WH22X32357 and WH22X38441C evidence", () => {
  const catalog = { ...donor, ...GE_CONTROL, serial: "" };

  it("preserves a model-level historical candidate and directed service replacements", () => {
    const result = resolveOriginalMpn(catalog, GE_EVIDENCE);
    expect(result.factoryOriginalPrediction).toMatchObject({
      status: "candidate", resolvedMpnCanonical: null, candidates: [{ mpnCanonical: "WH22X32357" }]
    });
    expect(result.serviceReplacements).toMatchObject([
      { fromMpnCanonical: "WH22X32357", toMpnCanonical: "WH22X38441", source: { kind: "oem_model_diagram" } },
      { fromMpnCanonical: "WH22X32357", toMpnCanonical: "WH22X38441C", source: { kind: "reseller" } }
    ]);
  });

  it("keeps the same observed marking disputed without assigning the pictured board to the diagram model", () => {
    const result = resolveOriginalMpn({ ...catalog, machineNo: null, model: "", observedMarking: GE_MARKING }, GE_EVIDENCE);
    expect(result.factoryOriginalPrediction).toMatchObject({ status: "unresolved", resolvedMpnCanonical: null, candidates: [] });
    expect(result.markingEvidence).toMatchObject({
      observedMarking: GE_MARKING, status: "conflict", claims: [{ mpn: "WH18X28174" }, { mpn: "WH22X32357" }]
    });
    expect(result.serviceReplacements).toMatchObject([
      { fromMpnCanonical: "WH18X28174", toMpnCanonical: "WH22X38441C" },
      { fromMpnCanonical: "WH22X32357", toMpnCanonical: "WH22X38441C" }
    ]);
  });

  it("accepts a replacement-only catalog without deriving an original from either endpoint", () => {
    const evidence = GE_EVIDENCE.filter((claim) => claim.kind === "replacement");
    expect(resolveOriginalMpn(catalog, evidence)).toMatchObject({
      factoryOriginalPrediction: { status: "unresolved", candidates: [] },
      serviceReplacements: [{ fromMpnCanonical: "WH22X32357", toMpnCanonical: "WH22X38441" },
        { fromMpnCanonical: "WH22X32357", toMpnCanonical: "WH22X38441C" }]
    });
  });
});
