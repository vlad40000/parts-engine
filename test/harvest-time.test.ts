import { describe, expect, it } from "vitest";
import { parseHarvestSession, allocatedAccessMin, harvestTimeIssue, harvestTimeMessage } from "@/src/lib/harvest-time";
import { PUBLISHED_REPAIR_REFERENCES, REPAIR_REFERENCE_WARNING, referencesFor } from "@/src/lib/removal-references";
import { resolveRemoval, SEED_BASELINES } from "@/src/lib/removal";

const form = (partLines:string) => ({
  machineNo:"2508",observedOn:"2026-10-15",sharedAccessMin:"12.5",partLines
});

describe("harvest-time observations are independent of costs", () => {
  it("stores exact normalized MPN identities; shares access time once", () => {
    const result=parseHarvestSession(form("W10721967,4,2\nWPW10006384,3,1"));
    expect(result).toMatchObject({machineNo:"2508",observedOn:"2026-10-15",sharedAccessMin:12.5});
    expect(result.parts).toEqual([
      {mpnCanonical:"W10721967",mpnDisplay:"W10721967",removalMin:4,testMin:2},
      {mpnCanonical:"WPW10006384",mpnDisplay:"WPW10006384",removalMin:3,testMin:1}
    ]);
    expect(allocatedAccessMin(result.sharedAccessMin,result.parts.length)).toBe(6.25);
    expect(allocatedAccessMin(0,0)).toBeNull();
  });
  it("rejects duplicates, invalid dates, negatives and empty sessions", () => {
    expect(() => parseHarvestSession(form("W10721967,4,1\nw10721967,3,1"))).toThrow("Duplicate");
    expect(() => parseHarvestSession(form("W10721967,4"))).toThrow("one row");
    expect(() => parseHarvestSession({...form("W10721967,4,1"),observedOn:"2026-02-30"})).toThrow();
    expect(() => parseHarvestSession({...form("W10721967,4,1"),observedOn:"0000-01-01"})).toThrow("date");
    expect(() => parseHarvestSession({...form("W10721967,0,0"),sharedAccessMin:"0"})).toThrow("nonzero");
    expect(() => parseHarvestSession(form("W10721967,-2,0"))).toThrow("numbers");
  });
  it("retains entered display text and exposes only fixed error messages", () => {
    expect(parseHarvestSession(form("  wp-w10006384 ,3,1")).parts[0])
      .toMatchObject({mpnCanonical:"WPW10006384",mpnDisplay:"wp-w10006384"});
    try { parseHarvestSession(form("W10721967,-1,0")); } catch (e) { expect(harvestTimeIssue(e)).toBe("minutes"); }
    expect(harvestTimeIssue(new Error("query and private details", {cause:{code:"42P01",message:'relation "harvest_time_sessions" does not exist'}}))).toBe("unavailable");
    expect(harvestTimeIssue({cause:{code:"42703",message:'column p.mpn_display does not exist'}})).toBe("unavailable");
    expect(harvestTimeIssue({code:"42P01",message:'relation "unrelated" does not exist'})).toBe("error");
    expect(harvestTimeMessage("error")).not.toContain("private details");
    expect(harvestTimeMessage("toString")).toBeNull();
    expect(harvestTimeMessage("injected message")).toBeNull();
  });
  it("the 19 published guides are read-only and never influence the existing baseline", () => {
    expect(PUBLISHED_REPAIR_REFERENCES).toHaveLength(19);
    expect(REPAIR_REFERENCE_WARNING).toContain("NOT measured harvest removal");
    expect(referencesFor("Washer","Drain pump").length).toBeGreaterThan(0);
    expect(PUBLISHED_REPAIR_REFERENCES.every((r)=>r.harvest_min===null && r.source_url.startsWith("https://"))).toBe(true);
    const resolved=resolveRemoval({mpnCanonical:"NOTAREALMPN",appliance:"Washer",description:"Washer drain pump",baselines:SEED_BASELINES});
    expect(resolved).toMatchObject({minutes:15,source:"generic",component:"Drain pump"});
  });
});
