import { describe, expect, it } from "vitest";
import { canonicalizeMpn, MAX_ALIAS_HOPS, resolveAliasChain, wpPrefixTarget } from "@/src/lib/mpn";
import { brandKey, isUnreadableModel, modelKey } from "@/src/lib/model-key";

describe("canonicalizeMpn (D1)", () => {
  it.each([
    ["w11130238", "W11130238"],
    ["W-11130238", "W11130238"],
    [" W 11130238 ", "W11130238"],
    ["W10545371/A", "W10545371A"],
    ["WPW10545371", "WPW10545371"],
    ["DC47-00019A", "DC4700019A"],
    [null, ""]
  ])("%s → %s", (raw, expected) => {
    expect(canonicalizeMpn(raw)).toBe(expected);
  });

  it("does not strip WP; WP is an alias", () => {
    expect(wpPrefixTarget("WPW10545371")).toBe("W10545371");
    expect(wpPrefixTarget("W10545371")).toBeNull();
  });
});

describe("resolveAliasChain", () => {
  const edges = (pairs: Array<[string, string]>) => {
    const m = new Map(pairs);
    return (k: string) => m.get(k);
  };

  it("follows the whole chain, not one hop", () => {
    const next = edges([["W10142630", "W11375994"], ["W11375994", "WP285655"], ["WP285655", "285655"]]);
    expect(resolveAliasChain("W10142630", next)).toEqual({ canonical: "285655", hops: ["W11375994", "WP285655", "285655"], loop: false });
    expect(resolveAliasChain("WP285655", next).canonical).toBe("285655");
  });

  it("a number with no alias resolves to itself", () => {
    expect(resolveAliasChain("W11419052", edges([]))).toEqual({ canonical: "W11419052", hops: [], loop: false });
  });

  it("a loop resolves to nothing rather than an arbitrary key", () => {
    const next = edges([["A1", "B1"], ["B1", "C1"], ["C1", "A1"]]);
    expect(resolveAliasChain("A1", next)).toMatchObject({ canonical: "A1", loop: true });
    expect(resolveAliasChain("B1", next)).toMatchObject({ canonical: "B1", loop: true });
  });

  it("stops after MAX_ALIAS_HOPS", () => {
    const next = (k: string) => `${k}X`;
    expect(resolveAliasChain("A", next)).toMatchObject({ canonical: "A", loop: true });
    expect(resolveAliasChain("A", next).hops).toHaveLength(MAX_ALIAS_HOPS);
  });
});

describe("model identity", () => {
  it("keeps slashes, removes spaces dots dashes", () => {
    expect(modelKey("110.25132411")).toBe("11025132411");
    expect(modelKey("DV45H7000EW/A2")).toBe("DV45H7000EW/A2");
    expect(modelKey(" wtw5000dw1 ")).toBe("WTW5000DW1");
    expect(brandKey(" ge ")).toBe("GE");
  });
  it("flags unreadable models", () => {
    expect(isUnreadableModel("NO NAMEPLATE")).toBe(true);
    expect(isUnreadableModel("")).toBe(true);
    expect(isUnreadableModel("GDT535PSJ2SS")).toBe(false);
  });
});
