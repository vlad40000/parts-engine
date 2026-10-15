import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { sql } from "drizzle-orm";
import path from "node:path";
import * as schema from "@/src/db/schema";
import type { Db } from "@/src/db/types";
import { recordHarvestSession, recentHarvestSessions } from "@/src/db/harvest-time";
import { getBaselines } from "@/src/db/queries";
import { parseHarvestSession } from "@/src/lib/harvest-time";

let db:Db;
const measure=(partLines:string)=>parseHarvestSession({
  machineNo:"25",observedOn:"2026-10-15",sharedAccessMin:"18",partLines
});
beforeAll(async()=>{
  const client=new PGlite();
  db=drizzle(client,{schema}) as unknown as Db;
  await migrate(drizzle(client),{migrationsFolder:path.join(__dirname,"..","drizzle")});
  await db.execute(sql`insert into fleet_machines(machine_no,brand,brand_key,model_raw,model_key,identity_status)
    values('25','Whirlpool','WHIRLPOOL','WTW8500DC0','WTW8500DC0','ok')`);
  await db.execute(sql`insert into model_bom_cache(brand_key,model_key,brand_display,model_display,status)
    values('WHIRLPOOL','WTW8500DC0','Whirlpool','WTW8500DC0','found')`);
  await db.execute(sql`insert into model_part_edges(brand_key,model_key,mpn_canonical,mpn_display,source) values
    ('WHIRLPOOL','WTW8500DC0','W10721967','W10721967','test'),
    ('WHIRLPOOL','WTW8500DC0','W10006384','W10006384','test')`);
  await db.execute(sql`insert into mpn_master(mpn_canonical,mpn_display,description,part_family)
    values('W10721967','W10721967','Washer splutch kit','drive')`);
});
describe("observation-only database records",()=>{
  it("records shared time once and leaves operational minutes unchanged",async()=>{
    const baselines=await getBaselines(db);
    const id=await recordHarvestSession(db,measure("W10721967,5,2\nW10006384,3,1"));
    expect(id).toHaveLength(36);
    const rows=await recentHarvestSessions(db);
    expect(rows[0]).toMatchObject({machine_no:"25",part_count:2,allocated_access_min:9});
    expect(rows[0].parts).toEqual([
      {mpn:"W10006384",removal_min:3,test_min:1},
      {mpn:"W10721967",removal_min:5,test_min:2}
    ]);
    expect((await db.execute(sql`select shared_access_min from harvest_time_sessions`)).rows).toHaveLength(1);
    expect(await getBaselines(db)).toEqual(baselines);
    expect((await db.execute(sql`select removal_min, removal_source from mpn_master where mpn_canonical='W10721967'`)).rows[0])
      .toMatchObject({removal_min:null,removal_source:null});
  });
  it("rejects an unrelated MPN and does not create an orphan session",async()=>{
    await expect(recordHarvestSession(db,measure("NOTINBOM,5,1"))).rejects.toThrow("not on this machine");
    expect((await db.execute(sql`select count(*)::int as n from harvest_time_sessions`)).rows[0]).toMatchObject({n:1});
  });
});
