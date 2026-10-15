import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "./types";
import type { HarvestSessionInput } from "@/src/lib/harvest-time";
import { allocatedAccessMin, harvestTimeIssue, HarvestTimeValidationError } from "@/src/lib/harvest-time";
import { wpPrefixTarget } from "@/src/lib/mpn";

/** Observation-only records; never update MPN removal minutes or economic baselines. */
export async function recordHarvestSession(db: Db, input: HarvestSessionInput): Promise<string> {
  // Require current verified fleet identity plus exact MPNs in a completed matching BOM.
  const match = await db.execute(sql`
    select e.mpn_canonical, a.alias_canonical
    from fleet_machines f
    join model_bom_cache c on c.brand_key=f.brand_key and c.model_key=f.model_key and c.status='found'
    join model_part_edges e on e.brand_key=f.brand_key and e.model_key=f.model_key
    left join mpn_alias a on a.mpn_canonical=e.mpn_canonical and a.kind='wp_prefix'
    where f.machine_no=${input.machineNo} and f.identity_status='ok'
  `);
  const rows=match.rows as unknown as {mpn_canonical:string;alias_canonical:string|null}[];
  const eligible=new Set(rows.map((r)=>r.mpn_canonical));
  // Only persisted WP identity aliases qualify. Supersessions/variants are relationships,
  // and arbitrary prefix stripping would invent evidence absent from this machine's BOM.
  const aliases=new Map(rows.filter((r)=>r.alias_canonical && wpPrefixTarget(r.alias_canonical)===r.mpn_canonical)
    .map((r)=>[r.alias_canonical!,r.mpn_canonical]));
  const parts=input.parts.map((p)=>{
    const canonical=eligible.has(p.mpnCanonical) ? p.mpnCanonical : aliases.get(p.mpnCanonical);
    if (!canonical) throw new HarvestTimeValidationError("bom");
    return {...p,mpnCanonical:canonical};
  });
  if (new Set(parts.map((p)=>p.mpnCanonical)).size!==parts.length) throw new HarvestTimeValidationError("duplicate");
  const id=randomUUID();
  // CTE ensures a single-statement all-or-nothing insert. Shared access appears once in parent.
  const data=JSON.stringify(parts.map((p)=>({mpn_canonical:p.mpnCanonical,mpn_display:p.mpnDisplay,removal_min:p.removalMin,test_min:p.testMin})));
  await db.execute(sql`
    with created as (
      insert into harvest_time_sessions (id,machine_no,observed_on,shared_access_min)
      values (${id}::uuid,${input.machineNo},${input.observedOn}::date,${input.sharedAccessMin})
      returning id
    )
    insert into harvest_time_parts (session_id,mpn_canonical,mpn_display,removal_min,test_min)
    select created.id,p.mpn_canonical,p.mpn_display,p.removal_min,p.test_min
    from created cross join jsonb_to_recordset(${data}::jsonb)
    as p(mpn_canonical text,mpn_display text,removal_min numeric,test_min numeric)
  `);
  return id;
}
export type HarvestSessionRow = {
  id:string;machine_no:string;observed_on:string;brand:string;model_raw:string;
  shared_access_min:string;part_count:number;
  parts:{mpn:string;mpn_display:string;removal_min:number;test_min:number}[];
  allocated_access_min:number|null;
};
export async function recentHarvestSessions(db:Db, limit=15):Promise<HarvestSessionRow[]> {
  const r=await db.execute(sql`
    select s.id,s.machine_no,s.observed_on,f.brand,f.model_raw,s.shared_access_min,
      count(p.mpn_canonical)::int as part_count,
      coalesce(json_agg(json_build_object('mpn',p.mpn_canonical,'mpn_display',p.mpn_display,
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

/** Failure in this optional panel must not take down the rest of Settings. */
export async function harvestTimePanel(db:Db) {
  try {
    return {sessions:await recentHarvestSessions(db),issue:null};
  } catch (error) {
    return {sessions:[],issue:harvestTimeIssue(error)};
  }
}
