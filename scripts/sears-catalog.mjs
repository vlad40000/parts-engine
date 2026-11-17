/**
 * Staging-only Sears PartsDirect Apollo catalog payload parser.
 * Read-only: accepts HTML strings; never fetches, persists, or mutates a model BOM.
 * Derived conceptually from hero-page-video-main.BACKUP Sears catalog adapter.
 */
const normalize = (v) => String(v || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
const asArray = (v) => Array.isArray(v) ? v : [];
const prefixed = (v,prefix) => v && typeof v === 'object'
  ? Object.entries(v).find(([k]) => k.startsWith(prefix))?.[1] : undefined;
const refKey = (v) => typeof v === 'string' ? v : (v?.__ref || null);
const deref = (db, v) => db?.[refKey(v)] || null;
const name = (v) => String(v || '').replace(/\s+/g,' ').trim();
const partKey = (v) => /^[A-Z0-9][A-Z0-9./-]{3,29}$/.test(String(v || '').trim().toUpperCase())
  ? normalize(v) : '';
const isOem = (v) => {
  const value = partKey(v);
  return value.length >= 5 && value.length <= 24 && /\d/.test(value)
    && !/^(PS|PD|AP)\d{4,}$/.test(value) && !/^\d{10,}$/.test(value);
};

/** Pull balanced JSON immediately after CATALOG_API_RESPONSE, not arbitrary scripts. */
export function extractSearsCatalogPayload(html) {
  const source = String(html || '');
  const at = source.indexOf('CATALOG_API_RESPONSE');
  if (at < 0) return null;
  const start = source.indexOf('{',at);
  if (start < 0) return null;
  let depth = 0, quote = false, escape = false;
  for (let i=start; i<source.length; i++) {
    const ch=source[i];
    if (escape) { escape=false;continue; }
    if (ch==='\\' && quote) {escape=true;continue;}
    if (ch==='"') {quote=!quote;continue;}
    if (quote) continue;
    if (ch==='{') depth++;
    else if (ch==='}' && --depth===0) {
      try {
        const data=JSON.parse(source.slice(start,i+1));
        return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
      } catch { return null; }
    }
  }
  return null;
}

function modelRoots(db) {
  const root=db?.ROOT_QUERY || {};
  const refs=Object.entries(root).filter(([k])=>k.startsWith('model('))
    .map(([,r])=>deref(db,r)).filter(Boolean);
  const fallback=Object.values(db||{}).filter((r)=>
    r && r.__typename==='Model' && r.hasParts===true
    && (prefixed(r,'parts(') || prefixed(r,'schematics(')));
  return [...new Set([...refs,...fallback])].filter((r)=>
    r?.__typename==='Model' && r.hasParts===true);
}
export function parseSearsCatalogPage(payload, expectedModel) {
  if (!payload || typeof payload!=='object') return {status:'no_payload',model:null,
    expectedCount:null,parts:[],schematics:[],observedCount:0,partsBlock:false};
  const candidates=modelRoots(payload);
  const target=normalize(expectedModel);
  const matching=candidates.filter((m)=>normalize(m.number||m.modelNumber)===target);
  if (!matching.length) return {status:candidates.length?'identity_mismatch':'no_model_detail',
    model:null,expectedCount:null,parts:[],schematics:[],observedCount:0,partsBlock:false};
  if (matching.length !== 1) return {status:'ambiguous_model',model:null,
    expectedCount:null,parts:[],schematics:[],observedCount:0,partsBlock:false};
  const model=matching[0];
  const brand=deref(payload,model.brand);
  const modelInfo={number:name(model.number||model.modelNumber),brand:name(brand?.name||brand?.label),
    hasParts:model.hasParts===true,id:model.id||null};
  const partsBlock=prefixed(model,'parts(');
  const expectedCount=Number.isInteger(partsBlock?.totalCount)&&partsBlock.totalCount>=0
    ? partsBlock.totalCount : null;
  const schematics=asArray(prefixed(model,'schematics(')?.schematics)
    .map((ref)=>deref(payload,ref)).filter(Boolean).map((diagram)=>({
      id:String(diagram.id||diagram.pageId||''),
      title:name(diagram.pageName||diagram.title||diagram.name)
    }));
  if (!partsBlock || !Array.isArray(partsBlock.parts)) return {
    status:'parts_block_missing',model:modelInfo,expectedCount,parts:[],schematics,
    observedCount:0,partsBlock:false};
  const parts=[],seen=new Set(),invalid=[];
  for (const link of partsBlock.parts) {
    const obj=deref(payload,link);
    if (!obj || obj.__typename!=='Part') {invalid.push('unresolved_part_reference');continue;}
    const raw=name(obj.number||obj.partNumber).toUpperCase();
    if (!isOem(raw)) {invalid.push('invalid_oem_number');continue;}
    const replacementBlock=prefixed(obj,'substitutedByList(')||obj.substitutedByList;
    const replacedBy=asArray(replacementBlock?.parts).map((r)=>deref(payload,r))
      .filter(Boolean).map((r)=>name(r.number||r.partNumber).toUpperCase())
      .filter(isOem);
    const context=deref(payload,asArray(obj.schematicContext)[0]);
    const section=name(obj.contextSchematicTitle||context?.pageName||'');
    const diagramKey=name(obj.contextSchematicKeyId||obj.keyNumber||obj.diagramNumber||'');
    const key=normalize(raw)+'|'+section+'|'+diagramKey;
    if(seen.has(key)) continue;
    seen.add(key);
    parts.push({original:raw,canonical:normalize(raw),section,diagramKey,
      replaces:[],replacedBy:[...new Set(replacedBy.filter((v)=>normalize(v)!==normalize(raw)))],
      description:name(obj.title||obj.description||obj.name),sourceId:obj.id||null});
  }
  return {status:invalid.length?'partial_unresolved_refs':'model_page_parsed',
    model:modelInfo,expectedCount,parts,schematics,observedCount:parts.length,
    partsBlock:true,invalidReferences:invalid.length};
}

/** Stitch pages without losing original vs replacement identity or OEM diagram lines. */
export function reconcileSearsPages(pages,maxPages) {
  const accepted=pages.filter((p)=>p?.status==='model_page_parsed'||p?.status==='partial_unresolved_refs');
  const errors=pages.length-accepted.length;
  const knownTotals=new Set(accepted.map((p)=>p.expectedCount).filter((x)=>x!==null));
  const knownModels=new Set(accepted.map((p)=>normalize(p.model?.number)));
  const parts=new Map();
  for (const page of accepted) for (const row of page.parts)
    parts.set(row.canonical+'|'+row.section+'|'+row.diagramKey,row);
  const total=knownTotals.size===1?[...knownTotals][0]:null;
  const missing=total===null?null:Math.max(total-parts.size,0);
  const reliable=errors===0 && knownModels.size===1 && knownTotals.size===1
    && parts.size===total && accepted.every((x)=>x.status==='model_page_parsed');
  return {status:reliable?'page_count_reconciled':'incomplete_sample',
    coverage:reliable?'complete_for_sears':'partial',pagesFetched:pages.length,
    maxPages,expectedCount:total,observedCount:parts.size,remainingExpected:missing,
    rejectedPages:errors,originalAndReplacementPreserved:true,
    parts:[...parts.values()],
    schematics:[...new Map(accepted.flatMap((x)=>x.schematics).map((x)=>[x.id,x])).values()]};
}
