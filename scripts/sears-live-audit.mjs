/**
 * Eight public GET requests, no database access. Intended for PR staging only.
 * Captures structural Sears catalog diagnostics, not raw HTML or entire catalogs.
 */
import {writeFile} from 'node:fs/promises';
import {CASES,httpGet,modelIdentity,allowedHost} from './supplier-probe.mjs';
import {extractSearsCatalogPayload,parseSearsCatalogPage} from './sears-catalog.mjs';
const sleep=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms));
async function main() {
  const outputs=[];
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
  await writeFile('/tmp/sears-structure-audit.json',JSON.stringify({generatedAt:new Date().toISOString(),
    mode:'read_only_public_catalog_structure',results:outputs},null,2)+'\n');
}
main().catch((error)=>{console.error('Sears diagnostic failure: '+error.message);process.exitCode=1;});
