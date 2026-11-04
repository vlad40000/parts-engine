import { eq, sql } from "drizzle-orm";
import type { Db } from "./types";
import * as t from "./schema";
import { isEditableFleetStatus } from "@/src/lib/fleet-status";
import { CONDITION_FOR_STATUS, SALE_GRADES } from "@/src/lib/tech-notes/vocabulary";
import { isSoldLocationMarker } from "@/src/lib/tech-notes/return-review";

type ReturnInput = {
  machineNo: string; expectedStatus: string; expectedLocation: string;
  status: string; location: string;
};
export type ReturnOutcome = "verified" | "invalid" | "not_found" | "conflict" | "not_return";

/**
 * One physical confirmation of a returned machine. Status, location, standard
 * condition, overrides, audit rows and open location-check resolution land in
 * one PostgreSQL statement or not at all. The original photos and notes are
 * retained for chronological/service review, never automatically applied.
 */
export async function verifyMachineReturn(db: Db, input: ReturnInput): Promise<ReturnOutcome> {
  const location = input.location.trim();
  // eslint-disable-next-line no-control-regex
  if (!input.machineNo || !isEditableFleetStatus(input.status) ||
    input.status === "SOLD" || input.status === "SCRAPPED" ||
    !location || location.length > 120 || /[\u0000-\u001f\u007f]/.test(location) ||
    isSoldLocationMarker(location) || /^scrapp?ed$/i.test(location) ||
    (input.expectedLocation ?? "").length > 120) return "invalid";

  const mapped = CONDITION_FOR_STATUS[input.status] ?? null;
  const standardCodes = [...Object.values(CONDITION_FOR_STATUS), ...SALE_GRADES.map((g) => g.condition)];
  const syncCondition = mapped !== null
    ? sql`(coalesce(btrim(o.condition), '') = '' or o.condition = any(array[${sql.join(standardCodes.map((c) => sql`${c}`), sql`, `)}]::text[]))`
    : sql`false`;

  const rows = (await db.execute(sql`
    with original as (
      select machine_no, availability, location, condition
      from fleet_machines
      where machine_no = ${input.machineNo}
        and availability = ${input.expectedStatus}
        and coalesce(location, '') = ${input.expectedLocation}
        and (availability = 'SOLD' or lower(btrim(coalesce(location,''))) in ('$$$sold$$$', 'sold', 'off lot', 'off-lot'))
      for update
    ),
    changed as (
      update fleet_machines f set
        availability = ${input.status}, location = ${location},
        condition = case when ${syncCondition} then ${mapped} else f.condition end,
        local_fields = case when ${syncCondition} and not ('condition' = any(f.local_fields))
          then array_append(f.local_fields, 'condition') else f.local_fields end,
        status_override = true, location_override = true,
        last_field_update_at = greatest(f.last_field_update_at, now()), updated_at = now()
      from original o
      where f.machine_no = o.machine_no
      returning f.machine_no, f.availability, f.location, f.condition
    ),
    status_logged as (
      insert into fleet_status_events(machine_no, previous_status, next_status, source, observed_at)
      select c.machine_no, o.availability, c.availability, 'return_verified', now()
      from changed c join original o on o.machine_no = c.machine_no
      where o.availability <> c.availability returning id
    ),
    status_confirmed as (
      insert into fleet_field_events(machine_no, field, previous_value, next_value, source, observed_at, confirmation)
      select c.machine_no, 'status', c.availability, c.availability, 'return_verified', now(), true
      from changed c join original o on o.machine_no = c.machine_no
      where o.availability = c.availability returning id
    ),
    location_logged as (
      insert into fleet_field_events(machine_no, field, previous_value, next_value, source, observed_at, confirmation)
      select c.machine_no, 'location', o.location, c.location, 'return_verified', now(),
        o.location is not distinct from c.location
      from changed c join original o on o.machine_no = c.machine_no returning id
    ),
    condition_logged as (
      insert into fleet_field_events(machine_no, field, previous_value, next_value, source, observed_at)
      select c.machine_no, 'condition', o.condition, c.condition, 'return_verified', now()
      from changed c join original o on o.machine_no = c.machine_no
      where o.condition is distinct from c.condition returning id
    ),
    listed as (
      insert into fleet_locations(name, source)
      select ${location}, 'return_verified' from changed
      on conflict (name) do nothing returning name
    ),
    location_checks_resolved as (
      update fleet_location_checks set resolved_at = now(), resolved_location = ${location}
      where machine_no in (select machine_no from changed) and resolved_at is null returning id
    )
    select c.machine_no,
      (select count(*) from status_logged) + (select count(*) from status_confirmed)
      + (select count(*) from location_logged) + (select count(*) from condition_logged)
      + (select count(*) from listed) + (select count(*) from location_checks_resolved) as recorded
    from changed c
  `)) as unknown as { rows: Array<{ machine_no: string; recorded: string | number }> };
  if (rows.rows.length) return "verified";
  const [machine] = await db.select({ availability: t.fleetMachines.availability, location: t.fleetMachines.location })
    .from(t.fleetMachines).where(eq(t.fleetMachines.machineNo, input.machineNo));
  if (!machine) return "not_found";
  if (machine.availability !== input.expectedStatus || (machine.location ?? "") !== input.expectedLocation) return "conflict";
  return "not_return";
}
