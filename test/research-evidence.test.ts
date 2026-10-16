import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { evidenceHash, parseEvidenceTable, type EvidenceOptions } from "@/src/lib/research-evidence";
import { readResearchEvidenceFile } from "@/src/lib/research-evidence-file";

const options:EvidenceOptions={blankSoldIsSkip:true,sellThroughUnit:"fraction"};
const parse=(rows:Record<string,unknown>[],opts=options)=>parseEvidenceTable(rows,{sourceSha256:evidenceHash(JSON.stringify(rows)),format:"evidence_table",sheet:null,options:opts});
const row=(extra:Record<string,unknown>={})=>({mpn:"SYNTH100",sold90:"3",avgItem:"10.123456789012345678",avgBuyerShipping:"0",sellThrough:"0.08022",...extra});

describe("lossless research evidence parsing",()=>{
  it("preserves raw precision and converts declared fraction units without rounding",()=>{
    const r=parse([row()]).rows[0];
    expect(r.metrics).toEqual({sold90:3,avgItem:"10.123456789012345678",avgBuyerShipping:"0",sellThrough:{value:"0.08022",unit:"fraction",percent:"8.022"}});
    expect(r.raw.price).toBe("10.123456789012345678");
    expect(r.observedOn).toBeNull();
  });
  it("keeps blank sold as Owner Skip and numeric zero as researched",()=>{
    const rows=parse([row({mpn:"SKIP100",sold90:"",avgItem:"",avgBuyerShipping:"",sellThrough:""}),row({mpn:"ZERO100",sold90:"0"})]).rows;
    expect(rows[0]).toMatchObject({decision:"owner_skip",metrics:{sold90:null},raw:{sold:""}});
    expect(rows[1]).toMatchObject({decision:"researched",metrics:{sold90:0}});
    expect(parse([row({sold90:"",avgItem:"",avgBuyerShipping:"",sellThrough:""})],{...options,blankSoldIsSkip:false}).rows[0].decision).toBe("unreviewed");
  });
  it("preserves explicit decisions, raw summary and audited subset as separate windows",()=>{
    const r=parse([row({ownerDecision:"RESEARCHED",salesComparability:"PARTIAL EXACT-COMPARABLE",auditedSold90:"2",auditedAvgItem:"6.99",auditedAvgBuyerShipping:"1.4133333333333333",observedOn:"2026-10-14",windowStart:"2026-07-16",windowEnd:"2026-10-14",auditedOn:"2026-10-10",auditedWindowStart:"2026-07-12",auditedWindowEnd:"2026-10-10",incorporatedOn:"2026-10-15"})]).rows[0];
    expect(r).toMatchObject({decision:"researched",comparability:"partial_exact_comparable",metrics:{sold90:3},audited:{sold90:2,avgItem:"6.99",avgBuyerShipping:"1.4133333333333333"},observedOn:"2026-10-14",auditedOn:"2026-10-10",incorporatedOn:"2026-10-15"});
  });
  it("honors explicit percentage units and percent signs, including zero",()=>{
    expect(parse([row({sellThrough:"0.45",sellThroughUnit:"percent"})]).rows[0].metrics.sellThrough?.percent).toBe("0.45");
    expect(parse([row({sellThrough:"45%"})]).rows[0].metrics.sellThrough?.percent).toBe("45");
    expect(parse([row({sellThrough:0})]).rows[0].metrics.sellThrough?.percent).toBe("0");
    expect(parse([row({sellThrough:0.00000001})]).rows[0].metrics.sellThrough?.percent).toBe("0.000001");
  });
  it.each([
    [row({sold90:"-1"}),"nonnegative"],[row({sold90:"1.5"}),"whole"],
    [row({avgItem:"1e3"}),"nonnegative"],[row({avgItem:"1000001"}),"over"],
    [row({ownerDecision:"OWNER SKIP"}),"conflicts"],[row({salesComparability:"guaranteed"}),"unsupported"],
    [row({observedOn:"2026-02-30"}),"valid"],[row({windowStart:"2026-10-15",windowEnd:"2026-10-14"}),"reversed"],
    [row({notes:"Contact synthetic.person@example.invalid"}),"contact"],
    [row({notes:"Call (555) 222-3333"}),"contact"]
  ])("rejects invalid or unsafe full-batch input %#",(r,message)=>{expect(()=>parse([row({mpn:"VALID100"}),r])).toThrow(String(message));});
  it.each([
    ["sold90","3%","Row 3 sold quantity must be a plain nonnegative number"],
    ["avgItem","45%","Row 3 item price must be a nonnegative decimal, optionally with a leading $"],
    ["sold90","3.0000000000000000001","Row 3 sold quantity must be a whole number"],
    ["avgItem","1000000.00000000000000000001","Row 3 item price is over 1,000,000"],
    ["auditedSold90","3%","Row 3 audited sold quantity must be a plain nonnegative number"],
    ["auditedAvgItem","45%","Row 3 audited item price must be a nonnegative decimal, optionally with a leading $"],
    ["auditedSold90","3.0000000000000000001","Row 3 audited sold quantity must be a whole number"],
    ["auditedAvgItem","1000000.00000000000000000001","Row 3 audited item price is over 1,000,000"],
    ["sold90","$3","Row 3 sold quantity must be a plain"],["auditedSold90","$3","Row 3 audited sold quantity must be a plain"],
    ["sellThrough","$0.45","Row 3 sell-through must be a nonnegative decimal, optionally with a trailing %"],
    ["auditedSellThrough","$0.45","Row 3 audited sell-through must be a nonnegative decimal, optionally with a trailing %"],
    ["avgBuyerShipping","5%","Row 3 buyer shipping must be a nonnegative decimal, optionally with a leading $"],
    ["auditedAvgBuyerShipping","5%","Row 3 audited buyer shipping must be a nonnegative decimal, optionally with a leading $"],
    ["sold90","1000000.0000000000001","Row 3 sold quantity is over 1,000,000"],
    ["avgBuyerShipping","$1,000,000.000000000000000000001","Row 3 buyer shipping is over 1,000,000"],
    ["sellThrough","1000000.00000000000000000001%","Row 3 sell-through is over 1,000,000"]
  ])("rejects the whole batch for invalid %s instead of stripping units or rounding (case %#)",(field,value,message)=>{
    expect(()=>parse([row({mpn:"VALID100"}),row({[field]:value})])).toThrow(message);
  });
  it("accepts exact boundaries, zero fractions, grouping and field-appropriate units without losing precision",()=>{
    const r=parse([row({sold90:"1,000,000.000",avgItem:"1000000.000",avgBuyerShipping:"$1,000,000.000",auditedSold90:"3.000",auditedAvgItem:"$12.50",auditedAvgBuyerShipping:"0.000"})]).rows[0];
    expect(r.metrics).toMatchObject({sold90:1000000,avgItem:"1000000.000",avgBuyerShipping:"1000000.000"});
    expect(r.audited).toMatchObject({sold90:3,avgItem:"12.50",avgBuyerShipping:"0.000"});
    expect(r.raw).toMatchObject({sold:"1,000,000.000",price:"1000000.000",shipping:"$1,000,000.000",auditedSold:"3.000"});
    expect(parse([row({sold90:1000000,avgItem:1000000})]).rows[0].metrics).toMatchObject({sold90:1000000,avgItem:"1000000"});
    expect(parse([row({sellThrough:"0.45%"})]).rows[0].metrics.sellThrough).toEqual({value:"0.45",unit:"percent",percent:"0.45"});
    expect(parse([row({auditedSellThrough:"45 %"})]).rows[0].audited.sellThrough).toEqual({value:"45",unit:"percent",percent:"45"});
  });
  it("rejects D1 collisions and conflicting header aliases",()=>{
    expect(()=>parse([row({mpn:"SYNTH-100"}),row({mpn:"synth100"})])).toThrow("duplicates");
    expect(()=>parse([row({"90 day sold":"3"})])).toThrow("More than one");
    expect(()=>parse([row({"SOLD90":"3"})])).toThrow("duplicate headers");
  });
});

describe("research file readers",()=>{
  it("accepts canonical CSV and never copies uploaded filenames into evidence",async()=>{
    const f=new File(["mpn,sold90,avgItem,avgBuyerShipping,sellThrough,sellThroughUnit\nSYNTH100,3,12.123456,0,0.45,percent\n"],"private.person@example.invalid.csv");
    const r=await readResearchEvidenceFile(f,options);
    expect(r.rows[0].metrics.sellThrough?.percent).toBe("0.45");
    expect(JSON.stringify(r)).not.toContain("private.person");
  });
  it("rejects malformed CSV before preview",async()=>{
    await expect(readResearchEvidenceFile(new File(['mpn,sold90\nSYNTH100,"3'],"x.csv"),options)).rejects.toThrow("unclosed");
    await expect(readResearchEvidenceFile(new File(['mpn,sold90\nSYNTH100,3,EXTRA'],"x.csv"),options)).rejects.toThrow("same number");
    await expect(readResearchEvidenceFile(new File(['mpn,sold90\nSYNTH100,3'],"x.txt"),options)).rejects.toThrow("CSV or XLSX");
  });
  it("reads namespace-prefixed master workbooks, absolute relationships and nonstandard VML without changing source bytes",async()=>{
    const wb=new ExcelJS.Workbook();
    wb.addWorksheet("Old snapshot").addRows([["MPN","90 day sold"],["STALE100",99]]);
    const ws=wb.addWorksheet("Research Order");
    ws.addRows([["MPN","90d eBay Units Sold","90d eBay Average Sold Price","Owner 90d Avg Shipping ($)","90d eBay Sell Through","Owner Decision","Sales Comparability","eBay Research Date"],
      ["SYNTH100",3,12.123456,0,0.08022,"RESEARCHED","UNVERIFIED AGGREGATE","2026-10-15"],
      ["SKIP100",null,null,null,null,"OWNER SKIP","OWNER SKIP","2026-10-15"]]);
    ws.getCell("A1").note="Synthetic column note";
    const zip=await JSZip.loadAsync(await wb.xlsx.writeBuffer());
    for(const entry of Object.values(zip.files)){
      if(entry.dir)continue;
      if(/^xl\/.*\.xml$/.test(entry.name)){
        const xml=await entry.async("string");
        if(xml.includes('xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"')){
          zip.file(entry.name,xml.replace('xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"','xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"').replace(/<(\/?)([A-Za-z][\w-]*)(?=[\s/>])/g,"<$1x:$2"));
        }
      }
      if(/^xl\/worksheets\/_rels\//.test(entry.name))zip.file(entry.name,(await entry.async("string")).replace(/Target="\.\.\//g,'Target="/xl/').replace(/vmlDrawing\d+\.vml/g,"vmldrawing.vml"));
    }
    const source=await zip.generateAsync({type:"uint8array"});
    const hash=evidenceHash(source);
    const parsed=await readResearchEvidenceFile(new File([source as BlobPart],"master.xlsx"),options);
    expect(evidenceHash(source)).toBe(hash);
    expect(parsed).toMatchObject({format:"master_workbook",sheet:"Research Order",sourceSha256:hash});
    expect(parsed.rows.map(r=>r.inputMpnKey)).toEqual(["SYNTH100","SKIP100"]);
    expect(parsed.rows[0]).toMatchObject({incorporatedOn:"2026-10-15",observedOn:null,metrics:{sellThrough:{percent:"8.022"}}});
  });
});
