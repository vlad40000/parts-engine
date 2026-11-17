/**
 * Eight public GET requests, no database access. Intended for PR staging only.
 * Captures structural Sears catalog diagnostics, not raw HTML or entire catalogs.
 */
import {writeFile} from 'node:fs/promises';
import {CASES,httpGet,modelIdentity,allowedHost} from './supplier-probe.mjs';
import {extractSearsCatalogPayload,parseSearsCatalogPage,reconcileSearsPages} from './sears-catalog.mjs';
const sleep=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms));
async function main() {
  const outputs=[],sears5713=new Map();
  for (const item of CASES) {
    const pages=item.machine==='5713'?[1,2,16]:[1];
    for (const pageNumber of pages) {
      if (outputs.length) await sleep(1000);
      const u=new URL(item.sears);
      if (pageNumber>1) u.searchParams.set('page',String(pageNumber));
      const url=u.toString();
      const response=await httpGet(url);
      const diag={machine:item.machine,brand:item.brand,model:item.model,page:pageNumber,
        httpStatus:response.status,allowed:allowedHost(response.finalUrl,'sears'),
        bodyBytes:response.html?.length||0,
        titleIdentity:modelIdentity(response.html,item),
        hasMarker:!!response.html?.includes('CATALOG_API_RESPONSE'),
        status:'unverified',expectedCount:null,loadedCount:0,
        schematics:0,originalsPreview:[],knownSuspension:null,
        warnings:[]};
      if(response.ok && diag.allowed && diag.titleIdentity==='confirmed') {
        const payload=extractSearsCatalogPayload(response.html);
        if (!payload) diag.status='no_structured_payload';
        else {
          const detail=parseSearsCatalogPage(payload,item.model);
          if (item.machine==='5713') sears5713.set(pageNumber,detail);
          diag.status=detail.status;
          diag.expectedCount=detail.expectedCount;
          diag.loadedCount=detail.parts.length;
          diag.schematics=detail.schematics.length;
          diag.originalsPreview=detail.parts.map((p)=>p.original).slice(0,5);
          const suspension=detail.parts.find((p)=>p.original==='W10256514' || p.original==='W10247710');
          if(suspension) diag.knownSuspension={
            original:suspension.original,replacedBy:suspension.replacedBy,
            section:suspension.section,diagramKey:suspension.diagramKey};
        }
      } else diag.status=response.ok?'identity_not_proven':'http_error';
      console.log('SEARS_DIAG '+JSON.stringify(diag));
      outputs.push(diag);
    }
  }
  if (process.argv.includes('--full-5713')) {
    const item=CASES.find((it)=>it.machine==='5713');
    const page1=sears5713.get(1);
    // The first page must independently establish a model-specific count and page size.
    const maxPages=page1?.expectedCount && page1?.observedCount
      ? Math.ceil(page1.expectedCount/page1.observedCount) : 0;
    if (maxPages < 1 || maxPages > 20) {
      console.log('SEARS_FULL_5713 '+JSON.stringify({status:'pagination_unresolved',maxPages}));
    } else {
      for (let page=2;page<=maxPages;page++) {
        if (sears5713.has(page)) continue;
        await sleep(1200);
        const url=new URL(item.sears);url.searchParams.set('page',String(page));
        const result=await httpGet(url.toString());
        if (!result.ok || !allowedHost(result.finalUrl,'sears')
            || modelIdentity(result.html,item)!=='confirmed') {
          sears5713.set(page,{status:'page_unavailable',parts:[],schematics:[],expectedCount:null});
          continue;
        }
        const detail=parseSearsCatalogPage(extractSearsCatalogPayload(result.html),item.model);
        sears5713.set(page,detail);
      }
      const merged=reconcileSearsPages(Array.from({length:maxPages},(_v,i)=>
        sears5713.get(i+1)||{status:'missing_page',parts:[],schematics:[],expectedCount:null}
      ),maxPages);
      const output={generatedAt:new Date().toISOString(),
        machine:'5713',model:item.model,readOnly:true,pagesExpected:maxPages,
        summary:{status:merged.status,coverage:merged.coverage,expectedCount:merged.expectedCount,
          observedCount:merged.observedCount,remainingExpected:merged.remainingExpected,
          rejectedPages:merged.rejectedPages,schematics:merged.schematics.length},
        parts:merged.parts,blockedOrInvalidPages:[...sears5713].filter(([,p])=>
          p.status!=='model_page_parsed').map(([index,p])=>({page:index,status:p.status}))};
      await writeFile('/tmp/sears-full-5713.json',JSON.stringify(output,null,2)+'\n');
      console.log('SEARS_FULL_5713 '+JSON.stringify({
        ...output.summary,pagesFetched:maxPages,
        originalSuspension:merged.parts.find((p)=>p.original==='W10256514')||null
      }));
    }
  }
  await writeFile('/tmp/sears-structure-audit.json',JSON.stringify({generatedAt:new Date().toISOString(),
    mode:'read_only_public_catalog_structure',results:outputs},null,2)+'\n');
}
main().catch((error)=>{console.error('Sears diagnostic failure: '+error.message);process.exitCode=1;});
