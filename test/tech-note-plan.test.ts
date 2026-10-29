import { describe, expect, it } from "vitest";
import { normalizeReading } from "@/src/lib/tech-notes/reading";
import { nearMachineNumbers, partKind, planNote, referencedMachineNumbers, type Answers, type MachineFact, type PlanFacts } from "@/src/lib/tech-notes/plan";
import { NOTE_STATUS_VALUES, parseCardDate, shopToday } from "@/src/lib/tech-notes/vocabulary";
import { FLEET_STATUS_OPTIONS } from "@/src/lib/fleet-status";

// Shapes follow real shop notes; serials are synthetic and no customer data appears.
const fact = (machineNo: string, o: Partial<MachineFact> = {}): MachineFact => ({
  machineNo, availability: "UNCHECKED", condition: "U - Unchecked", location: "Warehouse", diagnosis: null, notes: null,
  applianceType: "Washer - Top Load / Agitator", brand: "Whirlpool", modelRaw: "WTW5000DW1", serial: "TEST0001",
  stickerPrice: null, version: "2026-05-01 10:00:00+00", bomStatus: null, bomParts: [],
  lastUpdate: null, fieldUpdates: {}, partUpdates: {}, openLocationCheck: false, ...o
});
const FRIDGE = { applianceType: "Refrigerator - Side By Side", brand: "GE", modelRaw: "GSS20IEMDWW" };
const LOCATIONS = ["Showroom - Main", "Showroom - WH", "Shop", "ICU", "Warehouse", "Graveyard"].map((name) => ({ name, aliases: [] as string[] }));
const facts = (machines: MachineFact[], extra: Partial<PlanFacts> = {}): PlanFacts => ({
  machines: Object.fromEntries(machines.map((m) => [m.machineNo, m])), locations: LOCATIONS, today: "2026-05-22", uploadedOn: "2026-05-22",
  donorStatuses: ["PARTS ONLY", "NEEDS PARTS", "PARTS PROGRAM"], ...extra
});
const entry = (no: string, o: Record<string, unknown> = {}) => ({ machine: { text: no, confidence: "high", alternatives: [] }, ...o });
/** Readings without a date get today's, so each test is about one thing; date tests pass their own. */
const plan = (reading: Record<string, unknown>, f: PlanFacts, answers: Answers = {}) =>
  planNote(normalizeReading({ date: { text: "5/22/26", confidence: "high" }, ...reading }), f, answers);
const changes = (p: ReturnType<typeof plan>, key: string) => Object.fromEntries(p.entries.find((e) => e.key === key)!.changes.map((c) => [c.field, c.to]));
const history = (p: ReturnType<typeof plan>, key: string) => Object.fromEntries(p.entries.find((e) => e.key === key)!.history.map((c) => [c.field, c.to]));

describe("group line written once for several fridges (ICU)", () => {
  const f = facts([
    fact("6371", { ...FRIDGE, availability: "NEEDS PARTS", condition: "E - Needs Parts", location: "Shop", diagnosis: "Poor cool. Possible refrigerant leak." }),
    fact("5656", { ...FRIDGE }),
    fact("5902", { ...FRIDGE, diagnosis: "NO HANDLES" }),
    fact("6567", { ...FRIDGE, availability: "NEEDS PARTS", condition: "E - Needs Parts", location: "Shop" })
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

  it("moves every listed machine; ICU is a place, not a status, so only UNCHECKED machines are asked for one", () => {
    const p = plan(reading, f);
    expect(p.questions.map((q) => q.id)).toEqual(["status:e1", "status:e2"]);
    expect(changes(p, "e0")).toEqual({
      location: "ICU",
      diagnosis: "Poor cool. Possible refrigerant leak. Needs gassing.",
      notes: "5/21/26-Location: ICU (Between metal building & warehouse)."
    });
    const answered = plan(reading, f, { "status:e1": "set:NEEDS PARTS", "status:e2": "keep" });
    expect(answered.ready).toBe(true);
    expect(changes(answered, "e1")).toMatchObject({ availability: "NEEDS PARTS", condition: "E - Needs Parts", location: "ICU" });
    expect(changes(answered, "e2")).toEqual({
      location: "ICU", diagnosis: "NO HANDLES Needs gassing & handles.", notes: "5/21/26-Location: ICU (Between metal building & warehouse)."
    });
  });

  it("asks which machines a group line covers when the layout is unclear", () => {
    const unclear = { ...reading, groups: [{ ...reading.groups[0], appliesTo: [3], confidence: "low" }] };
    const p = plan(unclear, f);
    const q = p.questions.find((x) => x.kind === "group")!;
    expect(q.multi).toBe(true);
    expect(q.options.map((o) => [o.label, o.recommended])).toEqual([["#6371", false], ["#5656", false], ["#5902", false], ["#6567", true]]);
    expect(p.ready).toBe(false);
    const answered = plan(unclear, f, { [q.id]: "e0,e1,e2,e3", "status:e1": "keep", "status:e2": "keep" });
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
    expect(changes(p2, "e0")).toEqual({ location: "Red Building", diagnosis: "Motor just hums. Bad motor.", notes: "5/14/26-Location: Red Building." });
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
    const f = facts([fact("6142", { brand: "GE", modelRaw: "GTUP240EM5WW", applianceType: "Washer/Dryer Combo", availability: "NEEDS PARTS" })]);
    expect(plan({ entries: [entry("6142", { model: "GTUP240EM5WW" })] }, f).questions).toEqual([]);
    expect(plan({ entries: [entry("6142", { model: "MEDB880BW0" })] }, f).questions[0].prompt).toContain("The note says model MEDB880BW0, but #6142 is a GTUP240EM5WW.");
    expect(plan({ entries: [entry("6142", { problem: "needs gassing" })] }, f).questions[0].prompt).toContain('mentions "gassing"');
  });

  it("asks which entry counts when one machine appears twice", () => {
    const f = facts([fact("5533", { availability: "NEEDS PARTS" })]);
    const r = { entries: [entry("5533", { problem: "won't spin" }), entry("5533", { problem: "noisy" })] };
    const q = plan(r, f).questions.find((x) => x.kind === "duplicate")!;
    const answered = plan(r, f, { [q.id]: "e1" });
    expect(answered.entries[0].skipped).toBe(true);
    expect(changes(answered, "e1").diagnosis).toBe("Noisy.");
  });

  it("ignores a blank line and confirms a typed number that is sold", () => {
    const f = facts([fact("4261", { availability: "SOLD" })]);
    expect(plan({ entries: [entry("")] }, f)).toMatchObject({ questions: [], hasChanges: false, ready: false });
    const r = { entries: [entry("", { problem: "timer worn" })] };
    const q = plan(r, f).questions[0];
    expect(q.prompt).toBe("Entry 1: No machine number is written for it. Which machine is it?");
    const p2 = plan(r, f, { [q.id]: "text:4261" });
    expect(p2.questions.map((x) => [x.id, x.answer])).toEqual([[q.id, "text:4261"], ["offlot:e0:4261", null]]);
    expect(p2.entries[0].machineNo).toBeNull();
    expect(plan(r, f, { [q.id]: "text:4261", "offlot:e0:4261": "yes" }).entries[0].machineNo).toBe("4261");
    expect(plan(r, f, { [q.id]: "text:4261", "offlot:e0:4261": "skip" }).entries[0].skipped).toBe(true);
  });

  it("lists every number to load, including answers and part-line machines", () => {
    const r = normalizeReading({ entries: [entry("611", { machine: { text: "#611", confidence: "low", alternatives: ["6611"] }, parts: [{ name: "control", action: "replaced", otherMachine: "4261" }] })] });
    expect(referencedMachineNumbers(r, { "machine:e0": "text:612" }).sort()).toEqual(["4261", "611", "612", "6611"]);
    expect(nearMachineNumbers("611")).toContain("6611");
    expect(nearMachineNumbers("611")).toContain("617");
    expect(nearMachineNumbers("611")).not.toContain("011");
  });
});

describe("statuses: only the Fleet options, and only when written", () => {
  it("offers exactly the Fleet status options", () => {
    expect(NOTE_STATUS_VALUES).toEqual([...FLEET_STATUS_OPTIONS]);
    // An old card's "Being repaired" box is not a Fleet status: kept as words.
    expect(normalizeReading({ entries: [entry("1", { status: { checked: "BEING REPAIRED", phrases: [] } })] }).entries[0].status)
      .toEqual({ checked: "", phrases: ["Being repaired"], confidence: "high" });
  });

  it("never turns 'Ready for clean' into READY TO SALE, even on the showroom floor", () => {
    const f = facts([fact("6525", { modelRaw: "", availability: "NEEDS PARTS" })]);
    const r = { date: { text: "5/18/26", confidence: "high" }, entries: [entry("6525", {
      readyForClean: true, location: { name: "", text: "Showroom floor", confidence: "high" },
      parts: [{ mpn: "W10440786", name: "", action: "replaced", otherMachine: "", condition: "", confidence: "high" }], struck: ["possible bad dampers"]
    })] };
    const p = plan(r, f);
    const loc = p.questions.find((q) => q.kind === "location")!;
    expect(loc.options.slice(0, 2).map((o) => o.value)).toEqual(["use:Showroom - Main", "use:Showroom - WH"]);
    const done = plan(r, f, { [loc.id]: "use:Showroom - Main" });
    expect(done.questions.map((q) => q.kind)).toEqual(["location"]);
    expect(done.ready).toBe(true);
    expect(changes(done, "e0")).toEqual({
      location: "Showroom - Main",
      notes: "5/18/26-Location: Showroom - Main. Ready for clean. Replaced part (W10440786)."
    });
    expect(done.aliasesToAdd).toEqual([{ name: "Showroom - Main", alias: "showroom floor" }]);
    expect(done.entries[0].struck).toEqual(["possible bad dampers"]);
  });

  it("never changes status because a machine moved", () => {
    const f = facts([fact("4529", { ...FRIDGE, availability: "NEEDS PARTS", location: "Shop" })]);
    for (const to of ["ICU", "Graveyard", "Showroom - Main"]) {
      const p = plan({ entries: [entry("4529", { location: { name: to, text: "", confidence: "high" }, problem: "Possible bad control" })] }, f);
      expect(p.questions).toEqual([]);
      expect(changes(p, "e0").availability).toBeUndefined();
      expect(changes(p, "e0").location).toBe(to);
    }
  });

  it("keeps words that are not Fleet statuses in the repair notes", () => {
    const f = facts([fact("4529", { availability: "NEEDS PARTS" })]);
    const p = plan({ entries: [entry("4529", { status: { checked: "BEING REPAIRED", phrases: [], confidence: "high" } })] }, f);
    expect(p.questions).toEqual([]);
    expect(changes(p, "e0")).toEqual({ notes: "5/22/26-Being repaired." });
  });

  it("confirms a hard-to-read status from a shared line or written words, not only a marked box", () => {
    const f = facts([fact("4928", { availability: "NEEDS PARTS" }), fact("5000", { availability: "NEEDS PARTS" })]);
    const group = plan({ entries: [entry("4928"), entry("5000")], groups: [{ text: "parts only", status: { checked: "PARTS ONLY", phrases: [], confidence: "low" },
      location: { name: "", text: "", confidence: "high" }, appliesTo: [0, 1], confidence: "high" }] }, f);
    expect(group.questions.map((q) => q.id)).toEqual(["status:e0", "status:e1"]);
    expect(group.entries.flatMap((e) => e.changes).some((c) => c.field === "availability")).toBe(false);
    const words = plan({ entries: [entry("4928", { status: { checked: "", phrases: ["parts machine?"], confidence: "low" } })] }, f);
    expect(words.questions[0]).toMatchObject({ id: "status:e0", prompt: "#4928: the status looks like PARTS ONLY, but it is hard to read. Which is it?" });
  });

  it("asks when two statuses are written, and uses a written grade and price", () => {
    const f = facts([fact("4928")]);
    const two = plan({ entries: [entry("4928", { status: { checked: "READY TO SALE", phrases: ["Parts machine"], confidence: "high" } })] }, f);
    expect(two.questions[0].options.map((o) => o.value)).toEqual(["set:READY TO SALE", "set:PARTS ONLY", "keep"]);
    const sale = plan({ entries: [entry("4928", { status: { checked: "READY TO SALE", phrases: [], confidence: "high" }, grade: "c", price: { text: "$350", confidence: "high" },
      location: { name: "Showroom - Main", text: "", confidence: "high" } })] }, f);
    expect(sale.questions).toEqual([]);
    expect(changes(sale, "e0")).toMatchObject({ availability: "READY TO SALE", condition: "C - Fair", stickerPrice: "350.00" });
    expect(changes(sale, "e0").notes).toBe("5/22/26-Location: Showroom - Main. READY TO SALE. Sticker $350.");
  });

  it("confirms a status that takes a machine off the lot, and says when a machine joins the donor pool", () => {
    const f = facts([fact("4928", { availability: "NEEDS PARTS" })]);
    const r = { entries: [entry("4928", { status: { checked: "", phrases: ["Scrap it"], confidence: "high" } })] };
    const q = plan(r, f).questions[0];
    expect(q.id).toBe("offlot-status:e0");
    expect(changes(plan(r, f, { [q.id]: "keep" }), "e0").availability).toBeUndefined();
    const yes = plan(r, f, { [q.id]: "yes" });
    expect(changes(yes, "e0")).toMatchObject({ availability: "SCRAPPED", condition: "S - Scraped" });
    expect(yes.entries[0].info).toContain("#4928 leaves the donor pool.");
    const joins = plan({ entries: [entry("5000", { status: { checked: "PARTS ONLY", phrases: [], confidence: "high" } })] }, facts([fact("5000", { availability: "READY TO SALE", condition: "B - Good" })]));
    expect(joins.entries[0].info).toContain("#5000 joins the donor pool: PARTS ONLY is a donor status in Settings.");
  });

  it("asks for a status (Fleet options only) when a machine is still UNCHECKED but the note says what is wrong", () => {
    const f = facts([fact("6068", { modelRaw: "WTW8200YW0", location: "" })], { locations: [...LOCATIONS, { name: "Red Building", aliases: [] }] });
    const r = { date: { text: "5/12/26", confidence: "high" }, entries: [entry("6068", { problem: "need inner tub", location: { name: "Red Building", text: "Red building", confidence: "high" },
      parts: [{ mpn: "", name: "inner tub", action: "needed", otherMachine: "", condition: "", confidence: "high" }] })] };
    const q = plan(r, f).questions.find((x) => x.kind === "status")!;
    expect(q.prompt).toBe("#6068 is still UNCHECKED, but the note says what is wrong with it. What is its status now?");
    expect(q.options.map((o) => o.value)).toEqual(["set:NEEDS PARTS", "set:PARTS ONLY", "set:PARTS PROGRAM", "set:READY TO SALE", "keep"]);
    expect(q.options.find((o) => o.recommended)?.value).toBe("set:NEEDS PARTS");
    const p = plan(r, f, { [q.id]: "set:NEEDS PARTS" });
    expect(changes(p, "e0")).toEqual({
      availability: "NEEDS PARTS", condition: "E - Needs Parts", location: "Red Building",
      diagnosis: "Need inner tub.", notes: "5/12/26-Location: Red Building. NEEDS PARTS."
    });
    // An empty location is filled, not a conflict.
    expect(p.entries[0].locationCheck).toBeNull();
    expect(plan(r, facts([fact("6068", { availability: "NEEDS PARTS", location: "" })], { locations: [...LOCATIONS, { name: "Red Building", aliases: [] }] })).questions).toEqual([]);
  });

  it("keeps struck-through text out of the record", () => {
    const f = facts([fact("4946", { brand: "Speed Queen", availability: "NEEDS PARTS", location: "ICU", diagnosis: "Needs Control Board. Wash & Rinse lights stay on." })],
      { locations: [...LOCATIONS, { name: "Red Building", aliases: [] }] });
    const p = plan({ entries: [entry("4946", { struck: ["Bad motor"], location: { name: "Red Building", text: "Red building", confidence: "high" } })] }, f);
    expect(p.questions).toEqual([]);
    expect(changes(p, "e0")).toEqual({ location: "Red Building", notes: "5/22/26-Location: Red Building." });
  });
});

describe("parts: needed is not failed", () => {
  const bomParts = [
    { mpn: "WP3948891", display: "WP3948891", description: "Timer", family: "sensor_switch" },
    { mpn: "WP3355806", display: "WP3355806", description: "Lid Switch Assembly", family: "lock_latch" },
    { mpn: "W10185976", display: "W10185976", description: "Washer Drain Pump", family: "pump" }
  ];
  const laundry = fact("6171", { modelRaw: "LTE5243DZ0", applianceType: "Washer/Dryer Combo", availability: "NEEDS PARTS", bomStatus: "found", bomParts });
  const line = (o: Record<string, unknown>) => ({ mpn: "", name: "", action: "needed", otherMachine: "", condition: "", confidence: "high", ...o });

  it("reads each part line as one of six decisions", () => {
    expect(partKind({ action: "needed", condition: "" })).toBe("needed");
    expect(partKind({ action: "needed", condition: "bad" })).toBe("failed");
    expect(partKind({ action: "needed", condition: "missing" })).toBe("missing");
    expect(partKind({ action: "suspected", condition: "" })).toBe("suspected");
    expect(partKind({ action: "mentioned", condition: "bad" })).toBe("failed");
    expect(partKind({ action: "taken", condition: "" })).toBe("removed");
    expect(partKind({ action: "replaced", condition: "" })).toBe("replaced");
    expect(partKind({ action: "mentioned", condition: "" })).toBeNull();
  });

  it("keeps a needed part on pick lists, marked test first, and suggests the parts-list number one digit off", () => {
    const r = { entries: [entry("6171", { parts: [line({ mpn: "WP394889", name: "timer" })] })] };
    const q = plan(r, facts([laundry])).questions.find((x) => x.kind === "part")!;
    expect(q.options[0]).toMatchObject({ value: "use:WP3948891", recommended: true, detail: "Timer" });
    const done = plan(r, facts([laundry]), { [q.id]: "use:WP3948891" });
    expect(done.entries[0].partStates).toEqual([]);
    expect(done.entries[0].parts).toMatchObject([{ kind: "needed", mpn: "WP3948891", applied: true, testFirst: "sensor_switch" }]);
    expect(done.entries[0].testFirst).toEqual(["sensor_switch"]);
    expect(changes(done, "e0").diagnosis).toBe("Needs timer (WP3948891).");
  });

  it("marks a part failed only when the note says it is bad", () => {
    const r = { entries: [entry("6171", { parts: [line({ mpn: "WP3948891", name: "timer", condition: "bad" })] })] };
    const p = plan(r, facts([laundry]));
    expect(p.entries[0].partStates).toEqual([{ machineNo: "6171", mpn: "WP3948891", mpnDisplay: "WP3948891", state: "failed", note: "tech note", seenToken: null }]);
    expect(p.entries[0].testFirst).toEqual([]);
    expect(changes(p, "e0").diagnosis).toBe("Bad timer (WP3948891).");
  });

  it("confirms a hard-to-read part line before it changes availability, even when its number matches", () => {
    const r = { entries: [entry("6171", { parts: [line({ mpn: "WP3948891", name: "timer", condition: "bad", confidence: "low" })] })] };
    const p = plan(r, facts([laundry]));
    expect(p.questions.map((q) => q.id)).toEqual(["partread:e0:p0"]);
    expect(p.entries[0].partStates).toEqual([]);
    expect(plan(r, facts([laundry]), { "partread:e0:p0": "yes" }).entries[0].partStates).toMatchObject([{ state: "failed", mpn: "WP3948891" }]);
    const notes = plan(r, facts([laundry]), { "partread:e0:p0": "notes" });
    expect(notes.entries[0].partStates).toEqual([]);
    expect(notes.entries[0].parts).toEqual([]);
    expect(changes(notes, "e0").notes).toBe("5/22/26-Timer (WP3948891): failed.");
    // A hard-to-read "needs" line only flags test first, so it is not asked.
    expect(plan({ entries: [entry("6171", { parts: [line({ mpn: "WP3948891", name: "timer", confidence: "low" })] })] }, facts([laundry])).questions).toEqual([]);
  });

  it("matches a named missing part to the parts list", () => {
    const r = { entries: [entry("6171", { parts: [line({ name: "lid switch", condition: "missing" })] })] };
    const q = plan(r, facts([laundry])).questions.find((x) => x.kind === "part")!;
    expect(q.options.map((o) => o.value)).toEqual(["use:WP3355806", "keep"]);
    expect(plan(r, facts([laundry]), { [q.id]: "use:WP3355806" }).entries[0].partStates[0]).toMatchObject({ state: "missing", mpn: "WP3355806" });
  });

  it("flags a suspected part test first without asking or taking it off pick lists", () => {
    const p = plan({ entries: [entry("6171", { parts: [line({ name: "drain pump", action: "suspected" })] })] }, facts([laundry]));
    expect(p.questions).toEqual([]);
    expect(p.entries[0].parts).toMatchObject([{ kind: "suspected", mpn: null, testFirst: "pump", applied: true }]);
    expect(p.entries[0].partStates).toEqual([]);
    expect(changes(p, "e0").diagnosis).toBe("Check drain pump.");
  });

  it("records a replaced part, and the donor's part as removed only on a donor still on the lot", () => {
    const donor = fact("5000", { availability: "PARTS ONLY", modelRaw: "LTE5243DZ0", bomStatus: "found", bomParts });
    const r = { entries: [entry("6171", { parts: [line({ mpn: "WP3948891", name: "timer", action: "replaced", otherMachine: "5000" })] })] };
    const p = plan(r, facts([laundry, donor]));
    expect(p.entries[0].parts.map((d) => [d.machineNo, d.kind, d.applied])).toEqual([["6171", "replaced", true], ["5000", "removed", true]]);
    expect(p.entries[0].partStates).toEqual([{ machineNo: "5000", mpn: "WP3948891", mpnDisplay: "WP3948891", state: "pulled", note: "for #6171", seenToken: null }]);
    expect(changes(p, "e0").notes).toBe("5/22/26-Replaced timer (WP3948891) from #5000.");
    const sold = plan(r, facts([laundry, { ...donor, availability: "SOLD" }]));
    expect(sold.entries[0].partStates).toEqual([]);
    expect(sold.entries[0].info).toContain("#5000 is SOLD, so no part is marked removed there.");
  });

  it("asks which part a replacement names when it comes from a donor, so the donor's part is marked removed", () => {
    const donor = fact("5000", { availability: "PARTS ONLY", modelRaw: "LTE5243DZ0", bomStatus: "found", bomParts });
    const r = { entries: [entry("6171", { parts: [line({ name: "drain pump", action: "replaced", otherMachine: "5000" })] })] };
    const p = plan(r, facts([laundry, donor]));
    expect(p.ready).toBe(false);
    const q = p.questions.find((x) => x.id === "part:e0:p0")!;
    expect(q.options.map((o) => o.value)).toEqual(["use:W10185976", "keep"]);
    const done = plan(r, facts([laundry, donor]), { [q.id]: "use:W10185976" });
    expect(done.entries[0].parts.map((d) => [d.machineNo, d.kind, d.mpn])).toEqual([["6171", "replaced", "W10185976"], ["5000", "removed", "W10185976"]]);
    expect(done.entries[0].partStates).toMatchObject([{ machineNo: "5000", mpn: "W10185976", state: "pulled" }]);
    // Not sure which part: nothing is marked on the donor, and the review says so.
    const unsure = plan(r, facts([laundry, donor]), { [q.id]: "keep" });
    expect(unsure.entries[0].partStates).toEqual([]);
    expect(unsure.entries[0].info).toContain("drain pump has no parts-list number, so #5000's part is not marked removed.");
    // A replacement with no donor named is only recorded, so it is not asked.
    expect(plan({ entries: [entry("6171", { parts: [line({ name: "drain pump", action: "replaced" })] })] }, facts([laundry])).questions).toEqual([]);
  });

  it("records the donor's removal under the donor's own parts-list number, by the same chronology rules", () => {
    const recipient = fact("6171", { availability: "NEEDS PARTS", bomStatus: "found", bomParts: [{ mpn: "3948891", display: "WP3948891", description: "Timer", family: "sensor_switch" }] });
    const donorBom = [{ mpn: "WP3948891", display: "WP3948891", description: "Timer", family: "sensor_switch" }];
    const r = { entries: [entry("6171", { parts: [line({ mpn: "WP3948891", name: "timer", action: "replaced", otherMachine: "5000" })] })] };
    const donor = fact("5000", { availability: "PARTS ONLY", bomStatus: "found", bomParts: donorBom });
    expect(plan(r, facts([recipient, donor])).entries[0].partStates).toMatchObject([{ machineNo: "5000", mpn: "WP3948891", state: "pulled" }]);

    // The donor's part was marked failed the same day: ask which came last.
    const sameDay = { day: "2026-05-22", label: "on 5/22/26 9:05 AM (part record)" };
    const marked = fact("5000", { availability: "PARTS ONLY", bomStatus: "found", bomParts: donorBom, partUpdates: { WP3948891: { ...sameDay, state: "failed", token: "t1" } } });
    const q = plan(r, facts([recipient, marked])).questions.find((x) => x.id === "order:e0")!;
    expect(q.prompt).toContain("#5000's WP3948891 was set on 5/22/26 9:05 AM (part record)");
    expect(plan(r, facts([recipient, marked]), { "order:e0": "history" }).entries[0].partStates).toEqual([]);
    expect(plan(r, facts([recipient, marked]), { "order:e0": "apply" }).entries[0].partStates).toMatchObject([{ machineNo: "5000", state: "pulled", seenToken: "t1" }]);

    // A newer donor record is kept, with no question.
    const newer = fact("5000", { availability: "PARTS ONLY", bomStatus: "found", bomParts: donorBom, partUpdates: { WP3948891: { day: "2026-05-23", label: "on 5/23/26", state: "failed" } } });
    const kept = plan(r, facts([recipient, newer]));
    expect(kept.questions).toEqual([]);
    expect(kept.entries[0].partStates).toEqual([]);
    expect(kept.entries[0].parts.find((d) => d.machineNo === "5000")).toMatchObject({ kind: "removed", applied: false });
  });

  it("writes one state per part: the same state once, different states asked", () => {
    const donor = fact("5000", { availability: "PARTS ONLY", modelRaw: "LTE5243DZ0", bomStatus: "found", bomParts });
    const replaced = entry("6171", { parts: [line({ mpn: "WP3948891", name: "timer", action: "replaced", otherMachine: "5000" })] });
    const same = plan({ entries: [replaced, entry("5000", { parts: [line({ mpn: "WP3948891", name: "timer", action: "taken", otherMachine: "6171" })] })] }, facts([laundry, donor]));
    expect(same.questions).toEqual([]);
    expect(same.entries.flatMap((e) => e.partStates).map((x) => [x.machineNo, x.state])).toEqual([["5000", "pulled"]]);
    const r = { entries: [replaced, entry("5000", { parts: [line({ mpn: "WP3948891", name: "timer", condition: "missing" })] })] };
    const q = plan(r, facts([laundry, donor])).questions.find((x) => x.id === "partstate:5000|WP3948891")!;
    expect(q.options.map((o) => o.value)).toEqual(["set:pulled", "set:missing", "none"]);
    expect(plan(r, facts([laundry, donor])).ready).toBe(false);
    const missing = plan(r, facts([laundry, donor]), { [q.id]: "set:missing" });
    expect(missing.ready).toBe(true);
    expect(missing.entries.flatMap((e) => e.partStates).map((x) => [x.machineNo, x.state])).toEqual([["5000", "missing"]]);
    expect(missing.entries.flatMap((e) => e.parts).filter((d) => d.machineNo === "5000").map((d) => [d.kind, d.applied])).toEqual([["removed", false], ["missing", true]]);
    // Neither: no state, no applied decision, and the diagnosis does not say it either.
    const neither = plan(r, facts([laundry, donor]), { [q.id]: "none" });
    expect(neither.entries.flatMap((e) => e.partStates)).toEqual([]);
    expect(neither.entries.flatMap((e) => e.parts).filter((d) => d.machineNo === "5000").every((d) => !d.applied)).toBe(true);
    expect(changes(neither, "e1").diagnosis).toBeUndefined();
    expect(changes(missing, "e1").diagnosis).toBe("Timer (WP3948891) missing.");
  });

  it("asks about a part line's machine number that is not in the fleet", () => {
    const r = { entries: [entry("6171", { parts: [line({ name: "pressure switch", action: "taken", otherMachine: "21430" })] })] };
    const p = plan(r, facts([laundry, fact("2143")]));
    const q = p.questions.find((x) => x.kind === "other_machine")!;
    expect(q.options.map((o) => o.value)).toEqual(["use:2143", "keep"]);
    const done = plan(r, facts([laundry, fact("2143")]), { [q.id]: "use:2143" });
    expect(changes(done, "e0").notes).toBe("5/22/26-Took pressure switch for #2143.");
    expect(done.entries[0].parts).toMatchObject([{ kind: "removed", otherMachine: "2143" }]);
  });
});

describe("chronology: an older note never reverses a newer decision", () => {
  const newer = { day: "2026-05-20", label: "on 5/20/26 2:15 PM (Fleet edit)" };
  const machine = fact("4928", {
    availability: "READY TO SALE", condition: "B - Good", location: "Showroom - Main",
    fieldUpdates: { availability: newer, location: newer }, lastUpdate: { ...newer, label: `${newer.label}, status` }
  });
  const older = { date: { text: "5/18/26", confidence: "high" }, entries: [entry("4928", {
    status: { checked: "NEEDS PARTS", phrases: [], confidence: "high" }, location: { name: "Shop", text: "", confidence: "high" }, problem: "won't drain"
  })] };

  it("keeps an older note's status, condition and location as history only, with no question", () => {
    const p = plan(older, facts([machine]));
    expect(p.questions).toEqual([]);
    expect(p.ready).toBe(true);
    expect(Object.keys(changes(p, "e0"))).toEqual(["notes"]);
    expect(history(p, "e0")).toEqual({ availability: "NEEDS PARTS", condition: "E - Needs Parts", location: "Shop", diagnosis: "Won't drain." });
    expect(changes(p, "e0").notes).toBe("5/18/26-Location: Shop. NEEDS PARTS. Won't drain. (Older than the current record: kept as history.)");
    expect(p.entries[0].locationCheck).toBeNull();
  });

  it("applies a newer note over the same record", () => {
    const p = plan({ ...older, date: { text: "5/21/26", confidence: "high" } }, facts([machine]));
    expect(p.questions).toEqual([]);
    expect(changes(p, "e0")).toMatchObject({ availability: "NEEDS PARTS", location: "Shop" });
    expect(p.entries[0].history).toEqual([]);
  });

  it("asks when the note and the record were set the same day", () => {
    const sameDay = { ...older, date: { text: "5/20/26", confidence: "high" } };
    const q = plan(sameDay, facts([machine])).questions[0];
    expect(q).toMatchObject({ id: "order:e0", kind: "order" });
    expect(q.prompt).toContain("On the same day, status was set on 5/20/26 2:15 PM (Fleet edit); location was set on 5/20/26 2:15 PM (Fleet edit).");
    expect(q.options.find((o) => o.recommended)).toBeUndefined();
    expect(changes(plan(sameDay, facts([machine]), { "order:e0": "apply" }), "e0")).toMatchObject({ availability: "NEEDS PARTS", location: "Shop" });
    expect(history(plan(sameDay, facts([machine]), { "order:e0": "history" }), "e0")).toMatchObject({ availability: "NEEDS PARTS", location: "Shop" });
  });

  it("asks before an older note sets a field the newer record did not touch", () => {
    const m = fact("4928", { availability: "READY TO SALE", condition: "B - Good", location: "Warehouse", fieldUpdates: { availability: newer }, lastUpdate: { ...newer, label: `${newer.label}, status` } });
    const r = { date: { text: "5/18/26", confidence: "high" }, entries: [entry("4928", { location: { name: "Shop", text: "", confidence: "high" } })] };
    const q = plan(r, facts([m])).questions[0];
    expect(q.prompt).toBe("#4928: this note is dated 5/18/26. #4928 was updated on 5/20/26 2:15 PM (Fleet edit), status, after this note's date. Is this note the latest word on its location?");
    expect(q.options.find((o) => o.recommended)?.value).toBe("history");
    expect(history(plan(r, facts([m]), { "order:e0": "history" }), "e0")).toEqual({ location: "Shop" });
  });

  it("keeps an older part decision as history and never over a newer part record", () => {
    const bomParts = [{ mpn: "WP3948891", display: "WP3948891", description: "Timer", family: "sensor_switch" }];
    const m = fact("6171", { availability: "NEEDS PARTS", bomStatus: "found", bomParts, partUpdates: { WP3948891: { ...newer, state: "pulled" } } });
    const p = plan({ date: { text: "5/18/26", confidence: "high" }, entries: [entry("6171", {
      parts: [{ mpn: "WP3948891", name: "timer", action: "needed", otherMachine: "", condition: "bad", confidence: "high" }]
    })] }, facts([m]));
    expect(p.entries[0].parts).toMatchObject([{ kind: "failed", applied: false }]);
    expect(p.entries[0].partStates).toEqual([]);
  });

  it("asks for the date when none is written, offering the upload date", () => {
    const p = planNote(normalizeReading({ entries: [entry("4928", { problem: "noisy" })] }), facts([fact("4928", { availability: "NEEDS PARTS" })], { uploadedOn: "2026-05-21" }), {});
    const q = p.questions[0];
    expect(q.prompt).toContain("No date is written on this note.");
    expect(q.options.map((o) => [o.value, o.label])).toEqual([["set:2026-05-21", "Upload date (5/21/26)"], ["set:2026-05-22", "Today (5/22/26)"]]);
    expect(p.ready).toBe(false);
    expect(planNote(normalizeReading({ entries: [entry("4928", { problem: "noisy" })] }), facts([fact("4928", { availability: "NEEDS PARTS" })]), { date: "text:5/19/26" }).date).toBe("2026-05-19");
  });

  it("confirms a price or date that is hard to read, and refuses a typed date after today", () => {
    const f = facts([fact("4928", { availability: "NEEDS PARTS" })]);
    const r = { date: { text: "6/30/26", confidence: "high" }, entries: [entry("4928", { price: { text: "$3?0", confidence: "low" } })] };
    const p = plan(r, f);
    expect(p.questions.map((q) => q.kind)).toEqual(["date", "price"]);
    expect(p.questions[0].prompt).toContain("after today");
    expect(plan(r, f, { date: "text:6/1/26" }).questions[0].error).toBe("That date is after today.");
    const answered = plan(r, f, { date: "text:5/2/26", "price:e0": "text:$375" });
    expect(answered.date).toBe("2026-05-02");
    expect(changes(answered, "e0").stickerPrice).toBe("375.00");
  });
});

describe("confirmations", () => {
  it("dates a value the note confirms, without a change or a location check, only when the note is newer", () => {
    const m = fact("611", { availability: "NEEDS PARTS", location: "ICU", stickerPrice: "120.00" });
    const r = { entries: [entry("611", { status: { checked: "NEEDS PARTS", phrases: [], confidence: "high" }, location: { name: "ICU", text: "", confidence: "high" }, price: { text: "$120", confidence: "high" } })] };
    const p = plan(r, facts([m]));
    expect(p.entries[0].changes).toEqual([]);
    expect(p.entries[0].confirmed.map((c) => [c.field, c.to])).toEqual([["availability", "NEEDS PARTS"], ["location", "ICU"], ["stickerPrice", "120.00"]]);
    expect(p.entries[0].locationCheck).toBeNull();
    expect(p.ready).toBe(true);
    const older = fact("611", { availability: "NEEDS PARTS", location: "ICU", fieldUpdates: { location: { day: "2026-05-23", label: "on 5/23/26" } } });
    expect(plan(r, facts([older])).entries[0].confirmed.map((c) => c.field)).toEqual(["availability"]);
  });
});

describe("VERIFY LOCATION", () => {
  it("raises a check when the note records a different location than the record, and keeps both", () => {
    const p = plan({ entries: [entry("611", { location: { name: "Graveyard", text: "", confidence: "high" } })] }, facts([fact("611", { availability: "NEEDS PARTS", location: "ICU" })]));
    expect(p.entries[0].locationCheck).toEqual({ from: "ICU", to: "Graveyard" });
    expect(changes(p, "e0").location).toBe("Graveyard");
    // Same place: nothing to verify.
    expect(plan({ entries: [entry("611", { location: { name: "ICU", text: "", confidence: "high" } })] }, facts([fact("611", { availability: "NEEDS PARTS", location: "ICU" })])).entries[0].locationCheck).toBeNull();
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
