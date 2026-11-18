import { describe, expect, it } from "vitest";
import { getProductionDateEvidence } from "@/src/lib/production-date-evidence";
import { evaluateSerialApplicability, parseApplicabilityNote } from "@/src/lib/serial-applicability";

const ge = { brand: "GE", model: "EXAMPLE.01", serial: "SL200000Q", asOfYear: 2026 };
const whirlpool = { brand: "Whirlpool", model: "EXAMPLE0", serial: "CX3500001", asOfYear: 2026 };

describe("documented serial applicability", () => {
  it.each([
    ["Before serial SL200000Q", "excluded"],
    ["Through S/N: SL200000Q", "match"],
    ["After serial SL200000Q", "excluded"],
    ["Starting with serial SL200000Q", "match"],
    ["Serial range: SL100000Q-SL200000Q", "match"],
    ["Serial range [SL200000Q, SL300000Q)", "match"],
    ["Serial range (SL200000Q, SL300000Q]", "excluded"],
    ["Serial range [SL100000Q, SL200000Q)", "excluded"]
  ])("uses the documented endpoints in '%s'", (note, result) => {
    expect(evaluateSerialApplicability([note], ge)).toEqual(Array(4).fill(result));
  });

  it.each(["SL", "SL20000Q", "SL200000", "SL2000?00Q", "SM200000Q", "SL200000Z"])(
    "leaves incomplete or different GE series '%s' unknown", (serial) => {
      expect(new Set(evaluateSerialApplicability(["Before serial SL210000Q"], { ...ge, serial })))
        .toEqual(new Set(["unknown"]));
    }
  );

  it("accepts a serial label and separators without stripping characters from the identifier", () => {
    const input = { ...ge, serial: "S/N: sl-200000 q" };
    expect(getProductionDateEvidence(input).normalizedSerial).toBe("SL200000Q");
    expect(evaluateSerialApplicability(["Through SL200000Q"], input)).toEqual(Array(4).fill("match"));
  });

  it("uses Whirlpool plant, year code, week and numeric sequence", () => {
    expect(evaluateSerialApplicability(["After serial CX3499999"], whirlpool)).toEqual(Array(3).fill("match"));
    for (const serial of ["MX3500001", "CA3500001", "CX350001", "CX35000012", "CX5400001", "CX35000Z1"]) {
      expect(new Set(evaluateSerialApplicability(["After serial CX3499999"], { ...whirlpool, serial })))
        .toEqual(new Set(["unknown"]));
    }
    expect(evaluateSerialApplicability(["Through CX3500001"], { ...whirlpool, brand: "Kenmore", model: "110.21652020" }))
      .toEqual(Array(3).fill("match"));
  });

  it.each([
    "Before serial SL200000Q or after SL300000Q",
    "Serial range [SL300000Q, SL200000Q]",
    "Serial range (SL200000Q, SL200000Q]",
    "Serial range SL100000Q through SM300000Q",
    "After the change",
    "Before serial SL",
    "Built starting with 2018-02-29",
    "Production date range [2018-W01, 2018-06]",
    "Built from 2021 through 2018"
  ])("rejects invalid or unsupported compound notes '%s'", (note) => {
    expect(evaluateSerialApplicability([note], ge)).toBeNull();
  });

  it("recognizes an exact, separately documented model revision", () => {
    expect(parseApplicabilityNote("Model revision /01")).toEqual({ kind: "revision", code: "/01" });
    expect(evaluateSerialApplicability(["Revision /01"], { ...ge, revision: "/01" })).toEqual(Array(4).fill("match"));
    expect(evaluateSerialApplicability(["Revision /01"], { ...ge, revision: "/010" })).toEqual(Array(4).fill("excluded"));
    expect(evaluateSerialApplicability(["Revision /01"], ge)).toEqual(Array(4).fill("unknown"));
  });
});

describe("production date evidence", () => {
  it("keeps every GE and Whirlpool date candidate and its precision", () => {
    expect(getProductionDateEvidence(ge).candidates).toEqual(
      [1982, 1994, 2006, 2018].map((year) => ({ year, month: 9, week: null }))
    );
    expect(getProductionDateEvidence(whirlpool).candidates).toEqual(
      [1990, 2010, 2020].map((year) => ({ year, month: null, week: 35 }))
    );
    expect(getProductionDateEvidence({ ...whirlpool, asOfYear: 2018 }).candidates.map((c) => c.year)).toEqual([1990, 2010]);
    expect(getProductionDateEvidence({ ...ge, serial: "SL" }).candidates).toEqual([]);
  });

  it("keeps strict and inclusive date vocabulary distinct", () => {
    expect(parseApplicabilityNote("Made after 2018")).toMatchObject({ kind: "build_date", range: { start: { value: "2018", inclusive: false } } });
    expect(evaluateSerialApplicability(["Manufactured after 2006"], ge)).toEqual(["excluded", "excluded", "excluded", "match"]);
    expect(evaluateSerialApplicability(["Built since 2006"], ge)).toEqual(["excluded", "excluded", "match", "match"]);
    expect(evaluateSerialApplicability(["Production date range [1982-09, 2018-09]"], ge)).toEqual(Array(4).fill("match"));
  });

  it("leaves dates ambiguous when a bound cuts through the decoded month", () => {
    expect(evaluateSerialApplicability(["Manufactured before 2018-09-15"], ge)).toEqual(["match", "match", "match", "partial"]);
    expect(evaluateSerialApplicability(["Manufactured through 2018-09-30"], ge)).toEqual(Array(4).fill("match"));
  });

  it("can compare production weeks without guessing a day or calendar month", () => {
    expect(evaluateSerialApplicability(["Built through 2020-W35"], whirlpool)).toEqual(Array(3).fill("match"));
    expect(evaluateSerialApplicability(["Built through 2020-08"], whirlpool)).toEqual(["match", "match", "partial"]);
  });
});
