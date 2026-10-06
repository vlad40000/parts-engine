import { describe, expect, it } from "vitest";
import { bandsFor, decodeSerial, resolveFamily } from "@/src/lib/serial-decoder";

const NOW = new Date("2026-10-06T12:00:00Z");

describe("decodeSerial keeps every candidate year", () => {
  it("GE SL621054Q → L cycle, September, ambiguous (App 1 golden case)", () => {
    const d = decodeSerial("GE", "GTW485ASJ4WS", "SL621054Q", NOW);
    expect(d.candidateYears).toEqual([1982, 1994, 2006, 2018]);
    expect(d.month).toBe(9);
    expect(d.confidence).toBe("ambiguous");
  });

  it("Whirlpool SU1727374 → 2007 week 17, unique (App 1 golden case)", () => {
    const d = decodeSerial("Whirlpool", "WED4815EW", "SU1727374", NOW);
    expect(d.candidateYears).toEqual([2007]);
    expect(d.week).toBe(17);
    expect(d.confidence).toBe("unique");
  });

  it("Bosch FD950200451 → Feb 2015 (App 1 golden case)", () => {
    const d = decodeSerial("Bosch", "SHX3AR75UC", "FD950200451", NOW);
    expect(d.candidateYears).toEqual([2015]);
    expect(d.month).toBe(2);
  });

  it("Whirlpool D stays 1994 and 2024 (not collapsed to newest)", () => {
    const d = decodeSerial("Whirlpool", "WTW5000DW1", "CD2412345", NOW);
    expect(d.candidateYears).toEqual([1994, 2024]);
  });

  it("Samsung X → 2004 and 2024", () => {
    const d = decodeSerial("Samsung", "DV45H7000EW/A2", "0123ABCX5Y00001", NOW);
    expect(d.candidateYears).toEqual([2004, 2024]);
    expect(d.month).toBe(5);
  });

  it("drops years after the current year", () => {
    const d = decodeSerial("Frigidaire", "FFTW4120SW1", "XC72312345", NOW);
    expect(d.candidateYears).toEqual([1997, 2007, 2017]);
    expect(d.week).toBe(23);
  });

  it("routes Kenmore by model prefix", () => {
    expect(resolveFamily("Kenmore", "110.25132411")).toBe("WHIRLPOOL");
    expect(resolveFamily("Kenmore", "587.14802400")).toBe("ELECTROLUX");
    expect(resolveFamily("Kenmore", "ABC")).toBeNull();
  });

  it("routes legacy Maytag by model shape", () => {
    expect(resolveFamily("Maytag", "LAT9706AAE")).toBe("WHIRLPOOL");
    expect(resolveFamily("Maytag", "MAV2000AW")).toBe("MAYTAG_LEGACY");
    expect(resolveFamily("Maytag", "MVWX655DW1")).toBe("WHIRLPOOL");
  });

  it("no serial → none", () => {
    expect(decodeSerial("GE", "X", "", NOW).confidence).toBe("none");
  });
});

describe("age bands", () => {
  it("an ambiguous machine belongs to every band a candidate falls in", () => {
    expect(bandsFor([1982, 1994, 2006, 2018])).toEqual(["2015-2019", "2005-2009", "pre-2005"]);
    expect(bandsFor([2007])).toEqual(["2005-2009"]);
    expect(bandsFor([])).toEqual([]);
  });
});
