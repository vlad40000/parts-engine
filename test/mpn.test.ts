import { describe, expect, it } from "vitest";
import { canonicalizeMpn, wpPrefixTarget } from "@/src/lib/mpn";
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
