import { describe, expect, it } from "vitest";
import { normalizeReading } from "@/src/lib/tech-notes/reading";
import { nearMachineNumbers, planNote, referencedMachineNumbers, type Answers, type MachineFact, type PlanFacts } from "@/src/lib/tech-notes/plan";
import { parseCardDate, shopToday } from "@/src/lib/tech-notes/vocabulary";

// Shapes follow real shop notes; serials are synthetic and no customer data appears.
const fact = (machineNo: string, o: Partial<MachineFact> = {}): MachineFact => ({
  machineNo, availability: "UNCHECKED", condition: "U - Unchecked", location: "Warehouse", diagnosis: null, notes: null,
  applianceType: "Washer - Top Load / Agitator", brand: "Whirlpool", modelRaw: "WTW5000DW1", serial: "TEST0001",
  stickerPrice: null, version: "2026-05-01 10:00:00+00", bomStatus: null, bomParts: [], ...o
});
const FRIDGE = { applianceType: "Refrigerator - Side By Side", brand: "GE", modelRaw: "GSS20IEMDWW" };
const LOCATIONS = ["Showroom - Main", "Showroom - WH", "Shop", "ICU", "Warehouse", "Graveyard"].map((name) => ({ name, aliases: [] as string[] }));
const facts = (machines: MachineFact[], extra: Partial<PlanFacts> = {}): PlanFacts => ({
  machines: Object.fromEntries(machines.map((m) => [m.machineNo, m])), locations: LOCATIONS, today: "2026-05-22", ...extra
});
const entry = (no: string, o: Record<string, unknown> = {}) => ({ machine: { text: no, confidence: "high", alternatives: [] }, ...o });
const plan = (reading: Record<string, unknown>, f: PlanFacts, answers: Answers = {}) => planNote(normalizeReading(reading), f, answers);
const changes = (p: ReturnType<typeof plan>, key: string) => Object.fromEntries(p.entries.find((e) => e.key === key)!.changes.map((c) => [c.field, c.to]));

describe("group line written once for several fridges (ICU)", () => {
  const f = facts([
    fact("6371", { ...FRIDGE, availability: "BEING REPAIRED", condition: "X - Being Repaired", location: "Shop", diagnosis: "Poor cool. Possible refrigerant leak." }),
    fact("5656", { ...FRIDGE }),
    fact("5902", { ...FRIDGE, diagnosis: "NO HANDLES" }),
    fact("6567", { ...FRIDGE, availability: "BEING REPAIRED", condition: "X - Being Repaired", location: "Shop" })
  ]);
  const reading = {
    card: "free", date: { text: "5/21/26", confidence: "high" },
    entries: [
      entry("6371", { problem: "needs gassing" }), entry("5656", { problem: "needs gassing" }),
      entry("5902", { problem: "needs gassing & handles" }), entry("6567", { problem: "needs gassing" })
    ],
    groups: [{ text: "ICU! Between metal building & warehouse", status: { checked: "", phrases: ["ICU!"], confidence: "high" },
      location: { name: "ICU", text: "Between metal building & warehouse", confidence: "high" }, appliesTo: [0, 1, 2, 3], confidence: "high" }]
  };

  it("moves every listed machine with no questions", () => {
    const p = plan(reading, f);
    expect(p.questions).toEqual([]);
    expect(p.ready).toBe(true);
    expect(changes(p, "e0")).toEqual({
      availability: "NEEDS PARTS", condition: "E - Needs Parts", location: "ICU",
      diagnosis: "Poor cool. Possible refrigerant leak. Needs gassing.",
      notes: "5/21/26-Moved to ICU (Between metal building & warehouse). Needs parts."
    });
    expect(changes(p, "e2").diagnosis).toBe("NO HANDLES Needs gassing & handles.");
  });

  it("asks which machines a group line covers when the layout is unclear", () => {
    const unclear = { ...reading, groups: [{ ...reading.groups[0], appliesTo: [3], confidence: "low" }] };
    const p = plan(unclear, f);
    const q = p.questions.find((x) => x.kind === "group")!;
    expect(q.multi).toBe(true);
    expect(q.options.map((o) => [o.label, o.recommended])).toEqual([["#6371", false], ["#5656", false], ["#5902", false], ["#6567", true]]);
    expect(p.ready).toBe(false);
    const answered = plan(unclear, f, { [q.id]: "e0,e1,e2,e3" });
    expect(answered.ready).toBe(true);
    expect(answered.entries.every((e) => e.changes.some((c) => c.field === "location" && c.to === "ICU"))).toBe(true);
    // Covering none is a valid answer: only the machines' own lines apply.
    const none = plan(unclear, f, { [q.id]: "" });
    expect(none.entries.flatMap((e) => e.changes).some((c) => c.field === "location")).toBe(false);
  });
});

describe("machine number checks", () => {
  const speedQueen = fact("611", { brand: "Speed Queen", modelRaw: "AWS52NW", availability: "NEEDS PARTS", condition: "E - Needs Parts", location: "ICU", diagnosis: "Motor just hums." });

  it("confirms a hard-to-read number and offers only machines that exist", () => {
    const r = { entries: [entry("611", { machine: { text: "611", confidence: "low", alternatives: ["6611"] }, problem: "Bad motor", location: { name: "", text: "Red building", confidence: "high" } })], date: { text: "5/14/26", confidence: "high" } };
    const p = plan(r, facts([speedQueen]));
    const q = p.questions.find((x) => x.kind === "machine")!;
    expect(q.options.map((o) => o.value)).toEqual(["use:611", "skip"]);
    expect(q.options[0]).toMatchObject({ recommended: true, detail: "Speed Queen AWS52NW · Washer - Top Load / Agitator · NEEDS PARTS · ICU" });
    const p2 = plan(r, facts([speedQueen]), { [q.id]: "use:611", "location:red building": "add:Red Building" });
    expect(p2.ready).toBe(true);
    expect(changes(p2, "e0")).toEqual({ location: "Red Building", diagnosis: "Motor just hums. Bad motor.", notes: "5/14/26-Moved to Red Building." });
    expect(p2.locationsToAdd).toEqual([{ name: "Red Building", aliases: [] }]);
  });

  it("suggests near numbers when the number is not in the fleet, and rejects typed numbers that do not exist", () => {
    const f = facts([fact("6611"), fact("6621")]);
    const r = { entries: [entry("6612", { status: { checked: "NEEDS PARTS", phrases: [], confidence: "high" } })] };
    const p = plan(r, f);
    const q = p.questions.find((x) => x.kind === "machine")!;
    expect(q.prompt).toContain("There is no machine #6612.");
    expect(q.options.map((o) => o.value)).toEqual(["use:6611", "use:6621", "skip"]);
    const typed = plan(r, f, { [q.id]: "text:9999" });
    expect(typed.questions.find((x) => x.kind === "machine")).toMatchObject({ answer: null, error: "There is no machine #9999." });
    expect(plan(r, f, { [q.id]: "text:#6621" }).entries[0].machineNo).toBe("6621");
  });

  it("asks before touching a machine recorded as sold", () => {
    const p = plan({ entries: [entry("4261", { status: { checked: "READY TO SALE", phrases: [], confidence: "high" } })] }, facts([fact("4261", { availability: "SOLD" })]));
    const q = p.questions[0];
    expect(q.prompt).toContain("#4261 is recorded as SOLD.");
    expect(q.options.find((o) => o.value === "use:4261")?.recommended).toBe(false);
    expect(plan({ entries: [entry("4261")] }, facts([fact("4261", { availability: "SOLD" })]), { [q.id]: "skip" }).entries[0].skipped).toBe(true);
  });

  it("asks when the written model or the note's words do not fit the record", () => {
    const f = facts([fact("6142", { brand: "GE", modelRaw: "GTUP240EM5WW", applianceType: "Washer/Dryer Combo" })]);
    expect(plan({ entries: [entry("6142", { model: "GTUP240EM5WW" })] }, f).questions).toEqual([]);
    expect(plan({ entries: [entry("6142", { model: "MEDB880BW0" })] }, f).questions[0].prompt).toContain("The note says model MEDB880BW0, but #6142 is a GTUP240EM5WW.");
    expect(plan({ entries: [entry("6142", { problem: "needs gassing" })] }, f).questions[0].prompt).toContain('mentions "gassing"');
  });

  it("asks which entry counts when one machine appears twice", () => {
    const p = plan({ entries: [entry("5533", { problem: "won't spin" }), entry("5533", { problem: "noisy" })] }, facts([fact("5533")]));
    const q = p.questions.find((x) => x.kind === "duplicate")!;
    const answered = plan({ entries: [entry("5533", { problem: "won't spin" }), entry("5533", { problem: "noisy" })] }, facts([fact("5533")]), { [q.id]: "e1" });
    expect(answered.entries[0].skipped).toBe(true);
    expect(changes(answered, "e1").diagnosis).toBe("Noisy.");
  });

  it("lists every number to load, including answers and part-line machines", () => {
    const r = normalizeReading({ entries: [entry("611", { machine: { text: "#611", confidence: "low", alternatives: ["6611"] }, parts: [{ name: "control", action: "replaced", otherMachine: "4261" }] })] });
    expect(referencedMachineNumbers(r, { "machine:e0": "text:612" }).sort()).toEqual(["4261", "611", "612", "6611"]);
    expect(nearMachineNumbers("611")).toContain("6611");
    expect(nearMachineNumbers("611")).toContain("617");
    expect(nearMachineNumbers("611")).not.toContain("011");
  });
});

describe("status, grade and location", () => {
  it("reads 'Ready for clean' on the showroom floor as for sale, learns the location wording, and asks the grade", () => {
    const f = facts([fact("6525", { modelRaw: "" })]);
    const r = { date: { text: "5/18/26", confidence: "high" }, entries: [entry("6525", {
      readyForClean: true, location: { name: "", text: "Showroom floor", confidence: "high" },
      parts: [{ mpn: "W10440786", name: "", action: "replaced", otherMachine: "", condition: "", confidence: "high" }], struck: ["possible bad dampers"]
    })] };
    const p = plan(r, f);
    const loc = p.questions.find((q) => q.kind === "location")!;
    expect(loc.options.slice(0, 2).map((o) => o.value)).toEqual(["use:Showroom - Main", "use:Showroom - WH"]);
    const p2 = plan(r, f, { [loc.id]: "use:Showroom - Main" });
    const grade = p2.questions.find((q) => q.kind === "grade")!;
    expect(grade.options.find((o) => o.recommended)?.value).toBe("set:B - Good");
    const done = plan(r, f, { [loc.id]: "use:Showroom - Main", [grade.id]: "set:B - Good" });
    expect(done.ready).toBe(true);
    expect(changes(done, "e0")).toEqual({
      availability: "READY TO SALE", condition: "B - Good", location: "Showroom - Main",
      notes: "5/18/26-Moved to Showroom - Main. Ready for sale. Replaced part (W10440786)."
    });
    expect(done.aliasesToAdd).toEqual([{ name: "Showroom - Main", alias: "showroom floor" }]);
    expect(done.entries[0].struck).toEqual(["possible bad dampers"]);
    expect(done.entries[0].info).toEqual([
      '"Ready for clean" on the showroom floor is read as READY TO SALE.',
      "No parts list is cached for Whirlpool this model, so W10440786 goes in the notes only."
    ]);
  });

  it("asks what 'Ready for clean' means away from the showroom", () => {
    const p = plan({ entries: [entry("6146", { readyForClean: true })] }, facts([fact("6146")]));
    expect(p.questions[0].options.map((o) => o.value)).toEqual(["set:READY TO SALE", "set:BEING REPAIRED", "keep"]);
  });

  it("asks before changing status just because the machine moved", () => {
    const f = facts([fact("4529", { ...FRIDGE, availability: "BEING REPAIRED", location: "Shop" })]);
    const p = plan({ entries: [entry("4529", { location: { name: "ICU", text: "", confidence: "high" }, problem: "Possible bad control" })] }, f);
    const q = p.questions.find((x) => x.kind === "status")!;
    expect(q.prompt).toContain("Machines there are usually NEEDS PARTS");
    expect(changes(plan({ entries: [entry("4529", { location: { name: "ICU", text: "", confidence: "high" } })] }, f, { [q.id]: "keep" }), "e0")).toEqual({
      location: "ICU", notes: "5/22/26-Moved to ICU."
    });
  });

  it("asks when two statuses are marked, and uses a marked grade and price", () => {
    const f = facts([fact("4928")]);
    const two = plan({ entries: [entry("4928", { status: { checked: "READY TO SALE", phrases: ["Parts machine"], confidence: "high" } })] }, f);
    expect(two.questions[0].options.map((o) => o.value)).toEqual(["set:READY TO SALE", "set:PARTS ONLY", "keep"]);
    const sale = plan({ entries: [entry("4928", { status: { checked: "READY TO SALE", phrases: [], confidence: "high" }, grade: "c", price: { text: "$350", confidence: "high" },
      location: { name: "Showroom - Main", text: "", confidence: "high" } })] }, f);
    expect(sale.questions).toEqual([]);
    expect(changes(sale, "e0")).toMatchObject({ availability: "READY TO SALE", condition: "C - Fair", stickerPrice: "350.00" });
    expect(changes(sale, "e0").notes).toBe("5/22/26-Moved to Showroom - Main. Ready for sale. Sticker $350.");
  });

  it("confirms a price or date that is hard to read", () => {
    const f = facts([fact("4928")]);
    const p = plan({ date: { text: "6/30/26", confidence: "high" }, entries: [entry("4928", { price: { text: "$3?0", confidence: "low" } })] }, f);
    expect(p.questions.map((q) => q.kind)).toEqual(["date", "price"]);
    expect(p.questions[0].prompt).toContain("after today");
    const answered = plan({ date: { text: "6/30/26", confidence: "high" }, entries: [entry("4928", { price: { text: "$3?0", confidence: "low" } })] }, f,
      { date: "text:5/2/26", "price:e0": "text:$375" });
    expect(answered.date).toBe("2026-05-02");
    expect(changes(answered, "e0").stickerPrice).toBe("375.00");
  });

  it("keeps struck-through text out of the record", () => {
    const f = facts([fact("4946", { brand: "Speed Queen", availability: "NEEDS PARTS", location: "ICU", diagnosis: "Needs Control Board. Wash & Rinse lights stay on." })],
      { locations: [...LOCATIONS, { name: "Red Building", aliases: [] }] });
    const p = plan({ entries: [entry("4946", { struck: ["Bad motor"], location: { name: "Red Building", text: "Red building", confidence: "high" } })] }, f);
    expect(p.questions).toEqual([]);
    expect(changes(p, "e0")).toEqual({ location: "Red Building", notes: "5/22/26-Moved to Red Building." });
  });
});

describe("parts", () => {
  const bomParts = [
    { mpn: "WP3948891", display: "WP3948891", description: "Timer" },
    { mpn: "WP3355806", display: "WP3355806", description: "Lid Switch Assembly" },
    { mpn: "W10185976", display: "W10185976", description: "Washer Drain Pump" }
  ];
  const laundry = fact("6171", { modelRaw: "LTE5243DZ0", applianceType: "Washer/Dryer Combo", bomStatus: "found", bomParts });

  it("suggests the parts-list number when the written number is one digit off", () => {
    const r = { entries: [entry("6171", { parts: [{ mpn: "WP394889", name: "timer", action: "needed", otherMachine: "", condition: "bad", confidence: "high" }] })] };
    const p = plan(r, facts([laundry]));
    const q = p.questions.find((x) => x.kind === "part")!;
    expect(q.options[0]).toMatchObject({ value: "use:WP3948891", recommended: true, detail: "Timer" });
    const done = plan(r, facts([laundry]), { [q.id]: "use:WP3948891" });
    expect(done.entries[0].partStates).toEqual([{ machineNo: "6171", mpn: "WP3948891", mpnDisplay: "WP3948891", state: "failed", note: "tech note" }]);
    expect(changes(done, "e0").diagnosis).toBe("Needs timer (WP3948891).");
    const kept = plan(r, facts([laundry]), { [q.id]: "keep" });
    expect(kept.entries[0].partStates).toEqual([]);
    expect(changes(kept, "e0").diagnosis).toBe("Needs timer (WP394889).");
  });

  it("matches a named part to the parts list and records missing parts", () => {
    const r = { entries: [entry("6171", { parts: [{ mpn: "", name: "lid switch", action: "needed", otherMachine: "", condition: "missing", confidence: "high" }] })] };
    const q = plan(r, facts([laundry])).questions[0];
    expect(q.options.map((o) => o.value)).toEqual(["use:WP3355806", "keep"]);
    expect(plan(r, facts([laundry]), { [q.id]: "use:WP3355806" }).entries[0].partStates[0]).toMatchObject({ state: "missing", mpn: "WP3355806" });
  });

  it("marks a donor part pulled only on a donor still on the lot", () => {
    const donor = fact("5000", { availability: "PARTS ONLY", modelRaw: "LTE5243DZ0", bomStatus: "found", bomParts });
    const r = { entries: [entry("6171", { parts: [{ mpn: "WP3948891", name: "timer", action: "replaced", otherMachine: "5000", condition: "", confidence: "high" }] })] };
    const p = plan(r, facts([laundry, donor]));
    expect(p.entries[0].partStates).toEqual([{ machineNo: "5000", mpn: "WP3948891", mpnDisplay: "WP3948891", state: "pulled", note: "for #6171" }]);
    expect(changes(p, "e0").notes).toBe("5/22/26-Replaced timer (WP3948891) from #5000.");
    const sold = plan(r, facts([laundry, { ...donor, availability: "SOLD" }]));
    expect(sold.entries[0].partStates).toEqual([]);
    expect(sold.entries[0].info).toContain("#5000 is SOLD, so no part is marked pulled there.");
  });

  it("asks about a part line's machine number that is not in the fleet", () => {
    const r = { entries: [entry("6171", { parts: [{ mpn: "", name: "pressure switch", action: "taken", otherMachine: "21430", condition: "", confidence: "high" }] })] };
    const p = plan(r, facts([laundry, fact("2143")]));
    const q = p.questions.find((x) => x.kind === "other_machine")!;
    expect(q.options.map((o) => o.value)).toEqual(["use:2143", "keep"]);
    expect(changes(plan(r, facts([laundry, fact("2143")]), { [q.id]: "use:2143" }), "e0").notes).toBe("5/22/26-Took pressure switch for #2143.");
  });
});

describe("dates", () => {
  it("parses card dates and the shop day", () => {
    expect(parseCardDate("5/12/26")).toBe("2026-05-12");
    expect(parseCardDate("05-11-2026")).toBe("2026-05-11");
    expect(parseCardDate("2/30/26")).toBeNull();
    expect(shopToday(new Date("2026-10-30T02:00:00Z"))).toBe("2026-10-29");
  });
});
