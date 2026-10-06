/**
 * Part family + removal-time component classification from a BOM description.
 *
 * Family drives three things:
 *   - the research prefilter (fasteners / hardware / literature are skipped, logged)
 *   - failure-symptom matching (a part in a suspect family is not pulled for sale untested)
 *   - the standing rule that compressors are always scrap
 *
 * Component names match the "Removal Time Library" generic baselines exactly so the
 * minutes can be looked up without anyone retyping them.
 */

export const PART_FAMILIES = [
  "compressor",
  "literature",
  "fastener",
  "hardware",
  "control_board",
  "ui_panel",
  "pump",
  "motor",
  "valve",
  "heating",
  "gas",
  "sensor_switch",
  "lock_latch",
  "drive",
  "tub_basket",
  "suspension",
  "gasket_seal",
  "hose",
  "wiring",
  "ice_water",
  "rack_bin",
  "door_panel",
  "other"
] as const;

export type PartFamily = (typeof PART_FAMILIES)[number];

/** Families never researched by default (log + allow manual override). */
export const PREFILTER_SKIP_FAMILIES: PartFamily[] = ["fastener", "hardware", "literature"];

/** Standing rule: compressors are always scrap. */
export const ALWAYS_SCRAP_FAMILIES: PartFamily[] = ["compressor"];

const FAMILY_RULES: Array<[RegExp, PartFamily]> = [
  [/compressor(?!.*(relay|overload|capacitor|board|inverter))|sealed system|condenser coil|evaporator coil|\bdrier\b/i, "compressor"],
  [/manual|literature|instruction|tech sheet|wiring diagram|label|decal|sticker|warranty|energy guide|name ?plate|rating plate|cleaning tablet|cleaner|affresh/i, "literature"],
  [/\b(screws?|bolts?|nuts?|rivets?|clips?|clamps?|fasteners?|spacers?|grommets?|studs?|flat washer|lock washer|washer,? ?(flat|lock))\b/i, "fastener"],
  [/\b(bracket|brace|mount(ing)? plate|shim|leveling leg|leg|foot|feet|cap|plug|tie|strap)\b/i, "hardware"],
  [/user interface|\bui\b|display|touch ?pad|keypad|key pad|membrane|button|switch board|interface board/i, "ui_panel"],
  [/control board|main board|electronic control|machine control|\bpcb\b|\bacu\b|\bccu\b|\berc\b|inverter|control module|power board|relay board|board/i, "control_board"],
  [/pump/i, "pump"],
  [/motor|stator|rotor|blower wheel|fan blade|capacitor/i, "motor"],
  [/valve/i, "valve"],
  [/igniter|ignitor|burner|spark module|flame sensor|gas regulator|manifold|orifice/i, "gas"],
  [/element|heater|heating|thermal fuse|high.?limit|thermostat/i, "heating"],
  [/thermistor|sensor|switch|pressure|flow meter|timer|thermostat|relay|overload/i, "sensor_switch"],
  [/lock|latch|strike/i, "lock_latch"],
  [/belt|pulley|idler|clutch|transmission|gearcase|gear ?box|bearing|actuator|shifter|coupler|hub|roller|glide/i, "drive"],
  [/tub|basket|drum|agitator|impeller|wash ?plate|spray arm|sump|filter assembly/i, "tub_basket"],
  [/suspension|shock|damper|absorber|spring|counterweight|snubber/i, "suspension"],
  [/gasket|seal|boot|bellows|o-?ring/i, "gasket_seal"],
  [/\b(hoses?|tubes?|tubing|ducts?|vent)\b/i, "hose"],
  [/harness|wire|cord|terminal block|cable/i, "wiring"],
  [/ice|water filter|filter housing|dispenser|auger|reservoir/i, "ice_water"],
  [/\b(racks?|dishracks?|shel(f|ves)|bins?|drawers?|crispers?|trays?|slides?|rails?)\b/i, "rack_bin"],
  [/\b(doors?|panels?|console|covers?|lids?|top|handles?|trim|glass|cooktop|escutcheon|knobs?|grilles?|kick ?plate|cabinet|hinges?|bumpers?)\b/i, "door_panel"]
];

export function classifyFamily(description: string): PartFamily {
  const d = description.trim();
  if (!d) return "other";
  for (const [re, family] of FAMILY_RULES) if (re.test(d)) return family;
  return "other";
}

// ---------------------------------------------------------------------------
// Appliance type → Removal Time Library appliance
// ---------------------------------------------------------------------------
export type LibraryAppliance = "Washer" | "Dryer" | "Range" | "Refrigerator" | "Dishwasher" | "Microwave" | "Other";

export function libraryAppliance(applianceType: string | null | undefined): LibraryAppliance {
  const t = (applianceType ?? "").toLowerCase();
  if (/combo|washer\s*\/\s*dryer|laundry center/.test(t)) return "Washer";
  if (t.startsWith("washer") || /\bwasher\b/.test(t) && !/dish/.test(t)) return "Washer";
  if (/dryer/.test(t)) return "Dryer";
  if (/dish/.test(t)) return "Dishwasher";
  if (/microwave|otr/.test(t)) return "Microwave";
  if (/range|oven|stove|cooktop/.test(t)) return "Range";
  if (/refrig|freezer|fridge/.test(t)) return "Refrigerator";
  return "Other";
}

// ---------------------------------------------------------------------------
// Description → Removal Time Library component (per appliance)
// Order matters: the first match wins, so specific phrases come first.
// ---------------------------------------------------------------------------
const COMPONENT_RULES: Partial<Record<LibraryAppliance, Array<[RegExp, string]>>> = {
  Washer: [
    [/user interface|\bui\b|display|interface board|touch ?pad|keypad/i, "User-interface / display board"],
    [/motor control|inverter|\bmcu\b/i, "Motor control board / inverter"],
    [/control board|main board|electronic control|machine control|\bacu\b|\bccu\b|\bpcb\b|control unit/i, "Main control board / ACU"],
    [/timer/i, "Timer"],
    [/console|control panel/i, "Console / control panel assembly"],
    [/lid switch/i, "Lid switch"],
    [/lid lock|lid latch/i, "Lid lock assembly"],
    [/door lock|door latch|door interlock/i, "Front-load door lock"],
    [/inlet valve|water valve|fill valve/i, "Water inlet valve"],
    [/pressure switch|water level/i, "Pressure switch / water-level sensor"],
    [/flow meter/i, "Flow meter"],
    [/dispenser/i, "Detergent dispenser assembly"],
    [/recirc/i, "Recirculation pump"],
    [/pump/i, "Drain pump"],
    [/stator/i, "Stator"],
    [/rotor/i, "Rotor"],
    [/capacitor/i, "Motor capacitor"],
    [/shift|actuator/i, "Shift actuator"],
    [/motor/i, "Drive motor"],
    [/belt/i, "Drive belt"],
    [/pulley/i, "Drive pulley"],
    [/clutch/i, "Clutch assembly"],
    [/gearcase|gear case|transmission|gearbox|gear box/i, "Gearcase / transmission"],
    [/agitator/i, "Agitator"],
    [/impeller|wash ?plate/i, "Washplate / impeller"],
    [/hub/i, "Basket hub"],
    [/tub ring/i, "Tub ring"],
    [/basket/i, "Inner basket / spin basket"],
    [/outer tub|\btub\b/i, "Outer tub"],
    [/suspension rod|rod/i, "Suspension rod set"],
    [/shock|damper|absorber/i, "Shock absorbers"],
    [/spring/i, "Suspension springs"],
    [/counterweight|weight/i, "Counterweights"],
    [/boot|bellow/i, "Door boot / bellows"],
    [/hinge/i, "Door/lid hinge"],
    [/heater/i, "Heater"],
    [/thermistor|temperature sensor/i, "Temperature sensor / thermistor"],
    [/harness/i, "Main wiring harness"],
    [/top panel|top cover|\btop\b/i, "Top panel"],
    [/\blid\b/i, "Lid assembly"],
    [/door/i, "Door assembly"]
  ],
  Dryer: [
    [/user interface|\bui\b|display|interface board|touch ?pad|keypad/i, "User-interface / display board"],
    [/control board|main board|electronic control|machine control|\bpcb\b|control unit/i, "Main control board"],
    [/timer/i, "Timer"],
    [/console|control panel/i, "Console/control panel"],
    [/door switch/i, "Door switch"],
    [/thermal fuse/i, "Thermal fuse"],
    [/high.?limit/i, "High-limit thermostat"],
    [/thermostat/i, "Cycling thermostat"],
    [/thermistor/i, "Thermistor"],
    [/moisture sensor|sensor bar/i, "Moisture sensor"],
    [/heater housing|heater duct|heater box/i, "Complete heater housing"],
    [/element|heater/i, "Heating element"],
    [/valve coil|coil kit|solenoid/i, "Gas valve coils"],
    [/gas valve|valve/i, "Gas valve assembly"],
    [/igniter|ignitor/i, "Igniter"],
    [/flame sensor|radiant sensor/i, "Flame sensor"],
    [/burner/i, "Burner assembly"],
    [/blower wheel|blower/i, "Blower wheel"],
    [/motor/i, "Drive motor"],
    [/belt/i, "Drive belt"],
    [/idler|pulley/i, "Idler pulley"],
    [/roller/i, "Drum rollers"],
    [/rear bearing|drum bearing|bearing kit/i, "Rear drum bearing"],
    [/glide|front bearing|bearing/i, "Front bearing / glides"],
    [/drum/i, "Drum"],
    [/lint|duct|housing/i, "Lint duct / blower housing"],
    [/hinge/i, "Door hinge"],
    [/harness/i, "Wiring harness"],
    [/terminal block/i, "Terminal block"],
    [/power cord|cord/i, "Power cord"],
    [/top panel|\btop\b/i, "Top panel"],
    [/front panel/i, "Front panel"],
    [/rear panel|back panel/i, "Rear panel"],
    [/door/i, "Door assembly"]
  ],
  Range: [
    [/display|\bui\b|interface board/i, "Display / UI board"],
    [/touch ?pad|keypad|membrane/i, "Touchpad"],
    [/oven control|control board|\berc\b|electronic control|main board|clock/i, "Main oven control / ERC"],
    [/control panel|console|backguard/i, "Control-panel assembly"],
    [/infinite switch|surface switch|element switch/i, "Infinite switch"],
    [/induction (power|control|module|board|generator)|power module|inverter/i, "Induction power/control module"],
    [/induction/i, "Induction element"],
    [/radiant/i, "Radiant surface element"],
    [/coil element|surface element|surface unit/i, "Coil surface element"],
    [/spark module/i, "Spark module"],
    [/oven igniter|bake igniter|broil igniter|igniter, oven/i, "Oven igniter"],
    [/igniter|ignitor|spark electrode/i, "Surface burner igniter"],
    [/burner valve|surface valve|top burner valve/i, "Surface burner valve"],
    [/bake element/i, "Bake element"],
    [/broil element/i, "Broil element"],
    [/convection element/i, "Convection element"],
    [/convection (fan|motor)|fan motor/i, "Convection fan motor"],
    [/temperature sensor|oven sensor|sensor probe|rtd/i, "Oven temperature sensor"],
    [/thermal fuse|thermal cut/i, "Thermal fuse"],
    [/thermostat/i, "Thermostat"],
    [/latch|lock motor/i, "Door latch motor"],
    [/hinge/i, "Door hinges"],
    [/door glass|glass pack|window/i, "Door glass / glass pack"],
    [/glass cooktop|cooktop glass|main top|maintop/i, "Glass cooktop"],
    [/cooktop/i, "Complete cooktop assembly"],
    [/regulator/i, "Gas regulator"],
    [/manifold/i, "Gas manifold"],
    [/terminal block/i, "Terminal block"],
    [/power cord|cord/i, "Power cord"],
    [/drawer slide|slide/i, "Drawer slides"],
    [/drawer/i, "Warming/storage drawer"],
    [/light/i, "Oven-light assembly"],
    [/harness/i, "Main wiring harness"],
    [/element/i, "Bake element"],
    [/door/i, "Oven door assembly"]
  ],
  Refrigerator: [
    [/inverter|compressor (control|board)/i, "Compressor inverter board"],
    [/dispenser (control|board)|\bui\b|user interface|display|interface board/i, "Dispenser/UI control board"],
    [/led|light (control|board)/i, "LED/light-control board"],
    [/control board|main board|electronic control|\bpcb\b|power board/i, "Main control board"],
    [/ice maker (control|module|board)|ice.?maker control/i, "Ice-maker control/module"],
    [/ice maker|icemaker/i, "Ice maker assembly"],
    [/auger motor|auger/i, "Ice auger motor"],
    [/ice bin|ice bucket|ice container/i, "Ice-bin assembly"],
    [/paddle|lever|actuator arm/i, "Dispenser paddle/lever"],
    [/dispenser/i, "Complete dispenser assembly"],
    [/inlet valve|water valve/i, "Water inlet valve"],
    [/filter housing|filter head|filter manifold/i, "Filter housing / filter head"],
    [/reservoir|water tank/i, "Water reservoir"],
    [/evaporator fan|evap fan/i, "Evaporator fan motor"],
    [/condenser fan/i, "Condenser fan motor"],
    [/damper|diffuser/i, "Air damper / diffuser"],
    [/thermistor|temperature sensor/i, "Thermistor"],
    [/defrost thermostat|bimetal/i, "Defrost thermostat"],
    [/defrost heater|heater/i, "Defrost heater"],
    [/start relay|overload|start device/i, "Compressor start relay / overload"],
    [/capacitor/i, "Run capacitor"],
    [/thermostat|temperature control|cold control/i, "Temperature control / thermostat"],
    [/door switch|light switch/i, "Door switch"],
    [/gasket/i, "Door gasket"],
    [/hinge/i, "Door hinge"],
    [/handle/i, "Door handle"],
    [/mullion|flipper/i, "Mullion / flipper"],
    [/rail|slide/i, "Freezer drawer rails"],
    [/drawer front|freezer door|freezer drawer/i, "Freezer drawer front"],
    [/crisper|bin|drawer/i, "Crisper/freezer bin"],
    [/shelf/i, "Shelf"],
    [/air tower|duct/i, "Air tower / duct assembly"],
    [/harness/i, "Main wiring harness"],
    [/door/i, "Door assembly"]
  ],
  // No Removal Time Library baselines exist for these yet. The component names are
  // here so minutes can be entered once in Settings and every part picks them up.
  Dishwasher: [
    [/user interface|\bui\b|display|interface board|touch ?pad|keypad/i, "User-interface / display board"],
    [/control board|main board|electronic control|machine control|\bpcb\b|control unit/i, "Main control board"],
    [/console|control panel/i, "Console / control panel assembly"],
    [/float switch|float/i, "Float switch"],
    [/latch|door switch|interlock/i, "Door latch / switch"],
    [/drain pump/i, "Drain pump"],
    [/circulation pump|circ pump|wash motor|pump (and|&) motor|pump motor/i, "Circulation pump / wash motor"],
    [/pump/i, "Drain pump"],
    [/diverter/i, "Diverter motor"],
    [/inlet valve|water valve|fill valve/i, "Water inlet valve"],
    [/element|heater/i, "Heating element"],
    [/thermistor|turbidity|sensor|thermostat/i, "Thermistor / turbidity sensor"],
    [/spray arm|wash arm|spray tower/i, "Spray arm"],
    [/upper rack|upper dishrack|top rack/i, "Upper rack"],
    [/third rack|silverware|cutlery/i, "Silverware basket / third rack"],
    [/lower rack|lower dishrack|bottom rack|rack/i, "Lower rack"],
    [/roller|adjuster|wheel/i, "Rack rollers / adjusters"],
    [/dispenser/i, "Detergent dispenser"],
    [/gasket|seal/i, "Door gasket"],
    [/hinge|door spring|spring/i, "Door hinge / spring"],
    [/filter/i, "Filter assembly"],
    [/sump/i, "Sump assembly"],
    [/harness/i, "Wiring harness"],
    [/hose/i, "Drain / fill hose"],
    [/door/i, "Door assembly / outer panel"]
  ],
  Microwave: [
    [/touch ?pad|keypad|membrane/i, "Touchpad / membrane"],
    [/control board|main board|electronic control|\bpcb\b|smart board|relay board/i, "Main control board"],
    [/magnetron/i, "Magnetron"],
    [/transformer/i, "High-voltage transformer"],
    [/capacitor|diode/i, "High-voltage capacitor / diode"],
    [/door switch|interlock|monitor switch/i, "Door switch"],
    [/turntable motor|tray motor/i, "Turntable motor"],
    [/vent motor|fan motor|blower|cooling fan/i, "Fan / vent motor"],
    [/thermal (fuse|cutoff|cut-off)|thermostat|fuse/i, "Thermal fuse / cutoff"],
    [/waveguide/i, "Waveguide cover"],
    [/light|lamp/i, "Light / lamp"],
    [/tray|turntable/i, "Turntable tray"],
    [/door/i, "Door assembly"]
  ]
};

/** Components the classifier can assign for an appliance (for the Settings baseline editor). */
export function knownComponents(appliance: LibraryAppliance): string[] {
  return [...new Set((COMPONENT_RULES[appliance] ?? []).map(([, c]) => c))];
}

export const LIBRARY_APPLIANCES: LibraryAppliance[] = ["Washer", "Dryer", "Range", "Refrigerator", "Dishwasher", "Microwave"];

export function classifyComponent(appliance: LibraryAppliance, description: string): string | null {
  const rules = COMPONENT_RULES[appliance];
  if (!rules) return null;
  for (const [re, component] of rules) if (re.test(description)) return component;
  return null;
}

// ---------------------------------------------------------------------------
// Failure symptom → suspect families (Gemini gap #4)
// A part in a suspect family may be the reason the machine was retired.
// It is flagged, not silently pulled for sale.
// ---------------------------------------------------------------------------
const SYMPTOM_RULES: Array<[RegExp, PartFamily[]]> = [
  [/won'?t drain|not drain|no drain|drain(ing)? (issue|problem)|standing water|pump/i, ["pump"]],
  [/no power|dead|won'?t (turn|power) on|no display|error code|\bf\d{1,2}\b|\be\d{1,2}\b|\blc\b|\bde\b|board|control/i, ["control_board", "ui_panel"]],
  [/display|button|keypad|touch|panel not/i, ["ui_panel"]],
  [/no heat|not heat|won'?t heat|cold|heating/i, ["heating", "gas", "control_board"]],
  [/not cool|warm|no cool|won'?t cool|freezer not|fridge not/i, ["compressor", "motor", "control_board", "sensor_switch"]],
  [/leak/i, ["valve", "hose", "gasket_seal", "pump", "tub_basket"]],
  [/noise|noisy|loud|grind|squeal|bang|thump|bearing/i, ["drive", "motor", "suspension"]],
  [/won'?t spin|not spin|no spin|won'?t agitate|not agitat|won'?t tumble|drum not/i, ["motor", "drive", "lock_latch", "control_board"]],
  [/lid|door (lock|latch)|won'?t lock|locked/i, ["lock_latch"]],
  [/won'?t fill|no water|not fill|water (valve|inlet)/i, ["valve", "sensor_switch"]],
  [/ice|dispens/i, ["ice_water"]],
  [/igniter|ignit|won'?t light|no flame|gas/i, ["gas"]],
  [/burn|smoke|melt|fire|short/i, ["wiring", "control_board", "heating"]],
  [/motor/i, ["motor"]],
  [/belt/i, ["drive"]],
  [/rust|broken glass|cracked|dent/i, ["door_panel"]]
];

export function suspectFamilies(...texts: Array<string | null | undefined>): PartFamily[] {
  const joined = texts.filter(Boolean).join(" ");
  if (!joined.trim()) return [];
  const found = new Set<PartFamily>();
  for (const [re, families] of SYMPTOM_RULES) if (re.test(joined)) families.forEach((f) => found.add(f));
  return [...found];
}
