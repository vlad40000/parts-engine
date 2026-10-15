import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "./types";
import type { HarvestSessionInput } from "@/src/lib/harvest-time";
import { allocatedAccessMin } from "@/src/lib/harvest-time";

/** Observation-only records; never update MPN removal minutes or economic baselines. */
export async function recordHarvestSession(db: Db, input: HarvestSessionInput): Promise<string> {
  // Require current verified fleet identity plus exact MPNs in a completed matching BOM.
  const match = await db.execute(sql`
    select e.mpn_canonical
    from fleet_machines f
    join model_bom_cache c on c.brand_key=f.brand_key and c.model_key=f.model_key and c.status='found'
    join model_part_edges e on e.brand_key=f.brand_key and e.model_key=f.model_key
    where f.machine_no=${input.machineNo} and f.identity_status='ok'
  `);
  const eligible=new Set((match.rows as unknown as {mpn_canonical:string}[]).map((r)=>r.mpn_canonical));
  if (input.parts.some((p)=>!eligible.has(p.mpnCanonical))) {
    throw new Error("A selected MPN is not on this machine's completed exact-MPN parts list, or the machine needs nameplate verification.");
  }
  const id=randomUUID();
  // CTE ensures a single-statement all-or-nothing insert. Shared access appears once in parent.
  const data=JSON.stringify(input.parts.map((p)=>({mpn_canonical:p.mpnCanonical,removal_min:p.removalMin,test_min:p.testMin})));
  await db.execute(sql`
    with created as (
      insert into harvest_time_sessions (id,machine_no,observed_on,shared_access_min)
      values (${id}::uuid,${input.machineNo},${input.observedOn}::date,${input.sharedAccessMin})
      returning id
    )
    insert into harvest_time_parts (session_id,mpn_canonical,removal_min,test_min)
    select created.id,p.mpn_canonical,p.removal_min,p.test_min
    from created cross join jsonb_to_recordset(${data}::jsonb)
    as p(mpn_canonical text,removal_min numeric,test_min numeric)
  `);
  return id;
}
export type HarvestSessionRow = {
  id:string;machine_no:string;observed_on:string;brand:string;model_raw:string;
  shared_access_min:string;part_count:number;
  parts:{mpn:string;removal_min:number;test_min:number}[];
  allocated_access_min:number|null;
};
export async function recentHarvestSessions(db:Db, limit=15):Promise<HarvestSessionRow[]> {
  const r=await db.execute(sql`
    select s.id,s.machine_no,s.observed_on,f.brand,f.model_raw,s.shared_access_min,
      count(p.mpn_canonical)::int as part_count,
      coalesce(json_agg(json_build_object('mpn',p.mpn_canonical,
        'removal_min',p.removal_min,'test_min',p.test_min) order by p.mpn_canonical)
        filter(where p.mpn_canonical is not null),'[]'::json) as parts
    from harvest_time_sessions s
    join fleet_machines f on f.machine_no=s.machine_no
    left join harvest_time_parts p on p.session_id=s.id
    group by s.id,f.machine_no
    order by s.created_at desc,s.id desc
    limit ${Math.max(1,Math.min(50,limit))}
  `);
  return (r.rows as unknown as Omit<HarvestSessionRow,"allocated_access_min">[]).map((x)=>({
    ...x,allocated_access_min:allocatedAccessMin(Number(x.shared_access_min),Number(x.part_count))
  }));
}
