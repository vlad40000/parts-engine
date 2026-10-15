import { beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { sql } from "drizzle-orm";
import path from "node:path";
import * as schema from "@/src/db/schema";
import type { Db } from "@/src/db/types";
import { recordHarvestSession, recentHarvestSessions, harvestTimePanel } from "@/src/db/harvest-time";
import { getBaselines, getSettings, mpnIndex, mpnDetail, teardownQueue, physicalReviewQueue, machineDetail, researchQueueCsvRows, saveSettings } from "@/src/db/queries";
import { parseHarvestSession } from "@/src/lib/harvest-time";
import { readFileSync } from "node:fs";
import { recordHarvestTimeAction } from "@/app/actions";

const holder=vi.hoisted(()=>({db:null as unknown}));
vi.mock("@/src/db",()=>({getDb:async()=>holder.db,hasDatabase:()=>true}));
vi.mock("next/cache",()=>({revalidatePath:()=>undefined}));
vi.mock("next/navigation",()=>({redirect:(url:string)=>{throw new Error(`REDIRECT:${url}`);}}));

let db:Db;
const measure=(partLines:string)=>parseHarvestSession({
  machineNo:"25",observedOn:"2026-10-15",sharedAccessMin:"18",partLines
});
beforeAll(async()=>{
  const client=new PGlite();
  db=drizzle(client,{schema}) as unknown as Db;
  holder.db=db;
  await migrate(drizzle(client),{migrationsFolder:path.join(__dirname,"..","drizzle")});
  await db.execute(sql`insert into fleet_machines(machine_no,brand,brand_key,model_raw,model_key,identity_status)
    values('25','Whirlpool','WHIRLPOOL','WTW8500DC0','WTW8500DC0','ok')`);
  await db.execute(sql`insert into model_bom_cache(brand_key,model_key,brand_display,model_display,status)
    values('WHIRLPOOL','WTW8500DC0','Whirlpool','WTW8500DC0','found')`);
  await db.execute(sql`insert into model_part_edges(brand_key,model_key,mpn_canonical,mpn_display,source) values
    ('WHIRLPOOL','WTW8500DC0','W10721967','W10721967','test'),
    ('WHIRLPOOL','WTW8500DC0','W10006384','W10006384','test')`);
  await db.execute(sql`insert into mpn_master(mpn_canonical,mpn_display,description,part_family)
    values('W10721967','W10721967','Washer splutch kit','drive'),('W10006384','WPW10006384','Washer drive belt','drive')`);
  await db.execute(sql`insert into mpn_alias(alias_canonical,mpn_canonical,kind) values
    ('WPW10006384','W10006384','wp_prefix'),('OLDPART123','W10006384','supersedes'),
    ('VARIANT123','W10006384','variant'),('WPWRONGPART','W10006384','wp_prefix')`);
  await db.execute(sql`update model_part_edges set mpn_display='WPW10006384' where mpn_canonical='W10006384'`);
});
describe("observation-only database records",()=>{
  it("records shared time once and leaves operational minutes unchanged",async()=>{
    const baselines=await getBaselines(db);
    const id=await recordHarvestSession(db,measure("W10721967,5,2\nW10006384,3,1"));
    expect(id).toHaveLength(36);
    const rows=await recentHarvestSessions(db);
    expect(rows[0]).toMatchObject({machine_no:"25",part_count:2,allocated_access_min:9});
    expect(rows[0].parts).toEqual([
      {mpn:"W10006384",mpn_display:"W10006384",removal_min:3,test_min:1},
      {mpn:"W10721967",mpn_display:"W10721967",removal_min:5,test_min:2}
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
  it("accepts a persisted WP identity and preserves entered display provenance",async()=>{
    const id=await recordHarvestSession(db,measure("wp-w10006384,3,1"));
    const row=(await recentHarvestSessions(db)).find((r)=>r.id===id)!;
    expect(row.parts).toEqual([{mpn:"W10006384",mpn_display:"wp-w10006384",removal_min:3,test_min:1}]);
  });
  it("rejects alias/canonical duplicates, supersessions, variants, unproven or wrong WP targets atomically",async()=>{
    const before=await db.execute(sql`select count(*)::int as n from harvest_time_sessions`);
    await expect(recordHarvestSession(db,measure("W10006384,3,1\nWPW10006384,2,0"))).rejects.toThrow("Duplicate");
    for(const mpn of ["OLDPART123","VARIANT123","WPW10721967","WPWRONGPART","NOTINBOM"]){
      await expect(recordHarvestSession(db,measure(`${mpn},3,1`))).rejects.toThrow("not on this machine");
    }
    expect(await db.execute(sql`select count(*)::int as n from harvest_time_sessions`)).toEqual(before);
  });
  it("foreign-key and primary-key names match the Drizzle snapshot",async()=>{
    const snapshot=JSON.parse(readFileSync(path.join(__dirname,"..","drizzle/meta/0003_snapshot.json"),"utf8"));
    for(const table of ["harvest_time_sessions","harvest_time_parts"]){
      const constraints=await db.execute(sql`select conname from pg_constraint where conrelid=${table}::regclass and contype in ('f','p') order by conname`);
      const expected=[...Object.keys(snapshot.tables[`public.${table}`].foreignKeys),
        ...(table==="harvest_time_sessions" ? ["harvest_time_sessions_pkey"] : Object.keys(snapshot.tables[`public.${table}`].compositePrimaryKeys))].sort();
      expect((constraints.rows as {conname:string}[]).map((r)=>r.conname)).toEqual(expected);
    }
    await expect(db.execute(sql`insert into harvest_time_sessions(id,machine_no,observed_on,shared_access_min)
      values('00000000-0000-0000-0000-000000000001','missing','2026-10-15',1)`)).rejects.toThrow();
  });
  it("Settings action distinguishes validation, BOM and database failures and saves aliases",async()=>{
    const form=(partLines:string)=>{
      const f=new FormData();
      for(const [k,v] of Object.entries({machineNo:"25",observedOn:"2026-10-15",sharedAccessMin:"15",partLines})) f.set(k,v);
      return f;
    };
    await expect(recordHarvestTimeAction(form("WPW10006384,3,1\nW10721967,5,2"))).rejects.toThrow("timing=saved");
    await expect(recordHarvestTimeAction(form("WPW10006384,-3,1"))).rejects.toThrow("timing=minutes");
    await expect(recordHarvestTimeAction(form("NOTINBOM,3,1"))).rejects.toThrow("timing=bom");
    await expect(recordHarvestTimeAction(form("WPW10006384,3,1\nW10006384,5,2"))).rejects.toThrow("timing=duplicate");
    holder.db={execute:async()=>{throw new Error("private database error");}};
    await expect(recordHarvestTimeAction(form("W10006384,3,1"))).rejects.toThrow("timing=error");
    holder.db=db;
  });
  it("observation recording leaves all planning outputs and physical inventory unchanged",async()=>{
    await saveSettings(db,{...(await getSettings(db)),minimumSellThroughPct:20,minimumProfitMarginPct:10});
    await db.execute(sql`insert into market_facts(mpn_canonical,sold_90,avg_price,avg_ship,sell_through_pct,sell_through_source,source)
      values('W10721967',30,50,9,50,'research','manual')`);
    const outputs=async()=>({
      settings:await getSettings(db),baselines:await getBaselines(db),index:await mpnIndex(db,{view:"all"}),
      detail:await mpnDetail(db,"W10721967"),teardown:await teardownQueue(db),physical:await physicalReviewQueue(db),
      machine:await machineDetail(db,"25"),export:await researchQueueCsvRows(db),
      stock:(await db.execute(sql`select * from machine_part_state`)).rows,
      master:(await db.execute(sql`select * from mpn_master order by mpn_canonical`)).rows
    });
    const before=await outputs();
    await recordHarvestSession(db,measure("WPW10006384,300,100\nW10721967,200,50"));
    expect(await outputs()).toEqual(before);
  });
  it("keeps the optional panel available for 0002 databases and reports the missing update",async()=>{
    const client=new PGlite();
    const oldDb=drizzle(client,{schema}) as unknown as Db;
    for(const file of ["0000_init.sql","0001_roadrunner_sale_events.sql","0002_economics_v7.sql"]){
      for(const st of readFileSync(path.join(__dirname,"..","drizzle",file),"utf8").split("--> statement-breakpoint").filter((s)=>s.trim())) await client.exec(st);
    }
    expect(await harvestTimePanel(oldDb)).toEqual({sessions:[],issue:"unavailable"});
    expect((await getSettings(oldDb)).laborRateHr).toBe(15);
    await client.close();
  });
});
