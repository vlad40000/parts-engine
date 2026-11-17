/**
 * Read-only supplier-capability probes. Never writes Parts Engine database rows.
 * Page-level results are always sample evidence, NOT complete model BOMs.
 *
 * node scripts/supplier-probe.mjs --output=/tmp/probe.json
 * node scripts/supplier-probe.mjs --machines=5713 --providers=partsdr,coast
 * PROBE_READONLY_DATABASE_URL=... node scripts/supplier-probe.mjs --compare-db
 */
import { load } from 'cheerio';
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import {extractSearsCatalogPayload,parseSearsCatalogPage} from './sears-catalog.mjs';

export const CASES = [
  { machine:'5712', brand:'Maytag', model:'MVWB300WQ2', type:'washer', appRowsAtAudit:134, sears:'https://www.searspartsdirect.com/model/363jgyd8re-003048', partsdr:'https://partsdr.com/appliance-models/mvwb300wq2-maytag-washer', coast:'https://www.coastparts.com/lookup/213278/1199001' },
  { machine:'5713', brand:'Maytag', model:'MVWB755YQ0', type:'washer', appRowsAtAudit:148, sears:'https://www.searspartsdirect.com/model/5xlr0pc0dk-003048/maytag-mvwb755yq0-washer-parts', partsdr:'https://partsdr.com/appliance-models/mvwb755yq0-maytag-washer', coast:'https://www.coastparts.com/lookup/213396?k=item' },
  { machine:'6605', brand:'Whirlpool', model:'WED4616FW0', type:'dryer', appRowsAtAudit:104, sears:'https://www.searspartsdirect.com/model/51oqyg5ya5-001198/whirlpool-wed4616fw0-dryer-parts', partsdr:'https://partsdr.com/appliance-models/wed4616fw0-whirlpool-electric-dryer/parts', coast:'https://www.coastparts.com/lookup/249169' },
  { machine:'2121', brand:'GE', model:'GSS25WGTABB', type:'refrigerator', appRowsAtAudit:206, sears:'https://www.searspartsdirect.com/model/1vz4ux5obl-000432/ge-gss25wgtabb-side-by-side-refrigerator-parts', partsdr:'https://partsdr.com/appliance-models/gss25wgtabb-ge-refrigerator-t-series', coast:'https://www.geapplianceparts.com/store/parts/assembly/GSS25WGTABB' },
  { machine:'6660', brand:'Whirlpool', model:'WFE715H0ES0', type:'range', appRowsAtAudit:147, sears:'https://www.searspartsdirect.com/model/6dmfdrbspd-001198/whirlpool-wfe715h0es0-free-standing-electric-range-parts', partsdr:'https://partsdr.com/appliance-models/wfe715h0es0-whirlpool-electric-range/parts', coast:null },
  { machine:'58-1', brand:'GE', model:'JB645RK4SS', type:'range', appRowsAtAudit:87, sears:'https://www.searspartsdirect.com/model/afh11esodn-000432/ge-jb645rk4ss-free-standing-electric-range-parts', partsdr:'https://partsdr.com/appliance-models/jb645rk4ss-ge-electric-range/parts', coast:'https://www.geapplianceparts.com/store/parts/assembly/JB645RK4SS' }
];
export const PROVIDERS = ['partselect','partsdr','sears','coast','dlparts'];
const HOSTS = {partselect:['partselect.com'],partsdr:['partsdr.com'],sears:['searspartsdirect.com'],coast:['coastparts.com','geapplianceparts.com'],dlparts:['dlpartscolookup.com','dlpartsco.com']};
const FAMILIES = [['MAYTAG','WHIRLPOOL','KITCHENAID','AMANA','JENNAIR','ROPER'],['GE','GENERAL ELECTRIC','HOTPOINT','CAFE'],['FRIGIDAIRE','ELECTROLUX']];

export const normalized = (v) => String(v || '').trim().toUpperCase().replace(/[^A-Z0-9]/g,'');
export const validMpn = (v) => {
  const key = normalized(v);
  return key.length >= 5 && key.length <= 24 && /\d/.test(key) && !/^(PS|PD)\d{4,}$/.test(key) && !/^\d{10,}$/.test(key);
};
export function exactModelToken(value, model) {
  const target = normalized(model);
  return !!target && (String(value || '').toUpperCase().match(/[A-Z0-9]+(?:[./|-][A-Z0-9]+)*/g) || []).some((s) => normalized(s) === target);
}
export function modelIdentity(html, item) {
  const $ = load(html);
  const heading = [$('title').first().text(), $('h1').first().text(), $('meta[property="og:title"]').attr('content') || ''].join(' ').toUpperCase();
  if (!exactModelToken(heading,item.model)) return 'unresolved';
  const family = FAMILIES.find((f) => f.includes(item.brand.toUpperCase())) || [item.brand.toUpperCase()];
  const words = ' ' + heading.replace(/[^A-Z]+/g,' ').replace(/\s+/g,' ').trim() + ' ';
  return family.some((name) => words.includes(' ' + name + ' ')) ? 'confirmed' : 'unresolved';
}
export function providerUrl(item,provider) {
  if (provider === 'partselect') return 'https://www.partselect.com/Models/' + encodeURIComponent(item.model) + '/';
  if (provider === 'dlparts') return 'https://www.dlpartscolookup.com/lookup?site=prod-standard&search=' + encodeURIComponent(item.model);
  return item[provider] || null;
}
export function allowedHost(value,provider) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return !!HOSTS[provider]?.some((h) => host === h || host.endsWith('.' + h));
  } catch { return false; }
}
export function findDlPartsModelUrl(html,item,url) {
  const $ = load(html), candidates = [];
  $('a[href*="/lookup/"]').each((_i,element) => {
    const a = $(element);
    if (!exactModelToken(a.text(),item.model)) return;
    try {
      const found = new URL(a.attr('href'),url).toString();
      if (allowedHost(found,'dlparts') && /\/lookup\/\d+(?:\/|[?#]|$)/.test(found)) candidates.push(found);
    } catch { /* invalid candidate */ }
  });
  const unique = [...new Set(candidates)];
  return unique.length === 1 ? unique[0] : null;
}
function addPart(map,number,sourceText,section) {
  const mpn = String(number || '').trim().toUpperCase();
  if (!validMpn(mpn)) return;
  const key = normalized(mpn);
  const prev = map.get(key) || {mpn,canonical:key,section:section || null,replaces:[]};
  const replaces = [...String(sourceText || '').matchAll(/\bReplaces?\s*:\s*([A-Z0-9.-]{5,25})/gi)]
    .map((m) => normalized(m[1])).filter((p) => validMpn(p) && p !== key);
  prev.replaces = [...new Set([...prev.replaces,...replaces])];
  if (!prev.section && section) prev.section = section;
  map.set(key,prev);
}
export function extractPageEvidence(html,provider) {
  const $ = load(html); $('script,style,noscript,svg,footer,nav').remove();
  const parts = new Map(), sections = new Set();
  // Flattened page text can join OEM IDs to status words: "Part #72017In Stock"
  // became the fabricated identifier 72017IN in a live Sears probe.
  // Parse ONLY explicit OEM-labelled attributes or provider-specific table cells.
  $('[data-oem-part-number]').each((_i,el) =>
    addPart(parts,$(el).attr('data-oem-part-number'),$(el).text(),null));
  if (provider === 'dlparts') {
    $('table.table tbody tr, table.parts-list tbody tr').each((_i,el) => {
      const tr = $(el); addPart(parts,tr.find('td.partNumber, td.part-number').first().text(),tr.text(),null);
    });
    $('a.diagramText[href*="/lookup/"]').each((_i,el) => sections.add($(el).attr('href')));
  }
  if (provider === 'coast') {
    $('table tbody tr').each((_i,el) => {
      const cells = $(el).find('td').toArray().map((c) => $(c).text().replace(/\s+/g,' ').trim());
      if (cells.length >= 3 && /^\d{1,3}$/.test(cells[0])) addPart(parts,cells[1],cells.join(' '),null);
    });
  }
  const selector = provider === 'partselect' ? 'a[href*="/Sections/"]' : provider === 'partsdr' ? 'a[href*="/diagrams/"], a[href*="/diagram/"]' : provider === 'sears' ? 'a[href*="/diagram/"]' : null;
  if (selector) $(selector).each((_i,el) => sections.add($(el).attr('href')));
  return {parts:[...parts.values()],sectionsDiscovered:sections.size};
}
export async function httpGet(url) {
  const start = Date.now();
  try {
    const res = await fetch(url,{redirect:'follow',signal:AbortSignal.timeout(12000),headers:{
      'User-Agent':'PartsEngineReadOnlySupplierProbe/0.1 (public catalog capability audit)',
      Accept:'text/html,application/xhtml+xml','Accept-Language':'en-US,en;q=0.9'
    }});
    const contentType = res.headers.get('content-type') || '';
    const html = res.ok && /text\/html|application\/xhtml/i.test(contentType) ? (await res.text()).slice(0,3_000_000) : '';
    return {ok:res.ok,status:res.status,finalUrl:res.url || url,html,elapsedMs:Date.now()-start,contentType};
  } catch(err) {
    return {ok:false,status:0,finalUrl:url,html:'',elapsedMs:Date.now()-start,error:err instanceof Error ? err.message : String(err)};
  }
}
export async function probeOne(item,provider,fetcher=httpGet) {
  const requestedUrl = providerUrl(item,provider);
  const base = {machine:item.machine,model:item.model,brand:item.brand,provider,requestedUrl,
    finalUrl:null,httpStatus:null,outcome:'unverified',identity:'unresolved',coverage:'unknown',
    sectionsDiscovered:0,sectionsFetched:0,observedParts:[],observedCount:0,elapsedMs:0,warnings:[]};
  if (!requestedUrl) return {...base,outcome:'no_verified_url'};
  let response = await fetcher(requestedUrl);
  base.finalUrl = response.finalUrl || requestedUrl;
  base.httpStatus = response.status; base.elapsedMs = response.elapsedMs || 0;
  if (!allowedHost(base.finalUrl,provider)) return {...base,outcome:'redirected_off_provider'};
  if (response.status === 403) return {...base,outcome:'blocked_403'};
  if (response.status === 429) return {...base,outcome:'rate_limited_429'};
  if (response.status === 404) return {...base,outcome:'url_not_found'};
  if (!response.ok) return {...base,outcome:'http_error',warnings:[response.error || 'HTTP '+response.status]};
  if (!response.html) return {...base,outcome:'non_html_or_empty'};
  const title = load(response.html)('title').first().text();
  if (/access denied|captcha|verify you are human|checking your browser|attention required/i.test(title) || /cf-chl|id="challenge-form"/i.test(response.html))
    return {...base,outcome:'challenge'};
  if (provider === 'dlparts') {
    const detail = findDlPartsModelUrl(response.html,item,response.finalUrl);
    if (!detail) return {...base,outcome:'model_detail_unresolved',warnings:['D&L did not yield one unambiguous exact-model link']};
    response = await fetcher(detail);
    base.finalUrl = response.finalUrl || detail; base.httpStatus = response.status; base.elapsedMs += response.elapsedMs || 0;
    if (!allowedHost(base.finalUrl,provider)) return {...base,outcome:'redirected_off_provider'};
    if (!response.ok) return {...base,outcome:response.status === 403 ? 'blocked_403':'http_error'};
    if (!response.html) return {...base,outcome:'non_html_or_empty'};
  }
  base.identity = modelIdentity(response.html,item);
  if (base.identity !== 'confirmed') return {...base,outcome:'identity_unresolved',warnings:['Exact model + manufacturer absent from title/headings']};
  if (provider === 'sears') {
    const page = parseSearsCatalogPage(extractSearsCatalogPayload(response.html),item.model);
    if (page.status !== 'model_page_parsed' && page.status !== 'partial_unresolved_refs')
      return {...base,outcome:'structured_catalog_unresolved',warnings:['Sears catalog parser: '+page.status]};
    const payloadBrand = (page.model?.brand || '').toUpperCase();
    const family = FAMILIES.find((f)=>f.includes(item.brand.toUpperCase())) || [item.brand.toUpperCase()];
    if (payloadBrand && !family.includes(payloadBrand))
      return {...base,outcome:'structured_identity_mismatch',identity:'unresolved',
        warnings:['Sears payload brand differs from requested brand']};
    base.observedParts = page.parts.map((p)=>({
      mpn:p.original,canonical:p.canonical,section:p.section,
      diagramKey:p.diagramKey,replacedBy:p.replacedBy,evidenceType:'original_catalog_part'
    }));
    base.observedCount = page.parts.length;
    base.sectionsDiscovered = page.schematics.length;
    base.coverage = 'partial';
    base.sourceExpectedCount = page.expectedCount;
    base.sourcePagesFetched = 1;
    base.observedReplacements = [...new Set(page.parts.flatMap((p)=>p.replacedBy.map(normalized)))];
    base.outcome = page.parts.length ? 'structured_sample_parts_found' : 'structured_no_parts_observed';
    if (page.status === 'partial_unresolved_refs') base.warnings.push('One or more Sears part references could not be parsed');
    if (page.expectedCount === null) base.warnings.push('Sears has no reliable total count');
    return base;
  }
  const evidence = extractPageEvidence(response.html,provider);
  base.observedParts = evidence.parts;
  base.observedCount = evidence.parts.length;
  base.sectionsDiscovered = evidence.sectionsDiscovered;
  base.coverage = evidence.parts.length ? 'sample' : 'unknown';
  base.outcome = evidence.parts.length ? 'sample_parts_found' : 'model_confirmed_no_oem_rows';
  if (!evidence.parts.length) base.warnings.push('No safe OEM rows parsed; not proof of an empty catalog');
  return base;
}
export function compareToBaseline(probes,baseline) {
  const known = new Map((baseline?.models || []).map((entry) => [
    String(entry.brand).toUpperCase()+'|'+normalized(entry.model),new Set((entry.mpns || []).map(normalized))
  ]));
  return probes.map((probe) => {
    const rows = known.get(String(probe.brand).toUpperCase()+'|'+normalized(probe.model));
    return {...probe,baselineAvailable:!!rows,baselineMpnCount:rows?.size ?? null,
      candidateMissingFromApp:rows && probe.identity === 'confirmed'
        ? probe.observedParts.filter((p) => !rows.has(p.canonical)).map((p) => p.canonical) : [],
      replacementCandidatesMissingFromApp:rows && probe.identity === 'confirmed'
        ? [...new Set((probe.observedReplacements || []).filter((p)=>!rows.has(p)))] : [],
      comparisonStatus:rows ? 'sample_only_review_required' : 'baseline_unavailable'};
  });
}
export async function baselineFromReadOnlyDb(cases) {
  const uri = process.env.PROBE_READONLY_DATABASE_URL;
  if (!uri) return null;
  if (!/^postgres(?:ql)?:\/\//.test(uri)) throw new Error('PROBE_READONLY_DATABASE_URL must be a Postgres URI');
  const {neon} = await import('@neondatabase/serverless');
  const sql = neon(uri), models = [];
  for (const item of cases) {
    const rows = await sql.query('SELECT mpn_canonical FROM model_part_edges WHERE brand_key = $1 AND model_key = $2 ORDER BY mpn_canonical',[item.brand.toUpperCase(),item.model.toUpperCase()]);
    models.push({brand:item.brand,model:item.model,mpns:rows.map((r) => r.mpn_canonical)});
  }
  return {models};
}
export async function runProbes(cases,providers=PROVIDERS,fetcher=httpGet) {
  const out = [];
  for (const item of cases) for (const provider of providers) {
    if (out.length && fetcher === httpGet) await new Promise((resolve) => setTimeout(resolve,1000));
    out.push(await probeOne(item,provider,fetcher));
  }
  return out;
}
export function reportMarkdown(report) {
  return [
    '# Read-only supplier capability probe','',
    'Generated: '+report.generatedAt+'; baseline: '+report.baselineMode,
    'All collected parts are SAMPLE observations, not complete BOMs or verified installed donor parts.','',
    '| Machine | Model | Provider | Result | HTTP | Original MPNs | Missing original MPNs | Replacement candidates |',
    '|---|---|---|---|---:|---:|---:|---:|',
    ...report.results.map((r) => '| '+r.machine+' | '+r.model+' | '+r.provider+' | '+r.outcome+' | '+r.httpStatus+' | '+r.observedCount+' | '+r.candidateMissingFromApp.length+' | '+r.replacementCandidatesMissingFromApp.length+' |')
  ].join('\n')+'\n';
}
async function main() {
  const args = new Map(process.argv.slice(2).filter((s) => s.startsWith('--')).map((s) => {
    const [key,...tail] = s.slice(2).split('='); return [key,tail.join('=') || 'true'];
  }));
  const selected = (k,defaults) => args.has(k) ? args.get(k).split(',').map((s) => s.trim()) : defaults;
  const ids = selected('machines',CASES.map((c) => c.machine));
  const cases = CASES.filter((c) => ids.includes(c.machine));
  const providers = selected('providers',PROVIDERS);
  if (cases.length !== ids.length || providers.some((p) => !PROVIDERS.includes(p)))
    throw new Error('Unknown machine or provider in selection');
  let baseline = null, baselineMode = 'none';
  if (args.has('compare-db')) {
    baseline = await baselineFromReadOnlyDb(cases);
    if (!baseline) throw new Error('--compare-db requires PROBE_READONLY_DATABASE_URL (use SELECT-only credentials)');
    baselineMode = 'read_only_db';
  } else if (args.has('baseline')) {
    baseline = JSON.parse(await readFile(args.get('baseline'),'utf8'));
    baselineMode = 'local_json';
  }
  const raw = await runProbes(cases,providers);
  const report = {generatedAt:new Date().toISOString(),mode:'read_only_sample_probe',baselineMode,
    results:compareToBaseline(raw,baseline)};
  const output = args.get('output') || 'supplier-probe-output.json';
  await mkdir(path.dirname(output),{recursive:true});
  await writeFile(output,JSON.stringify(report,null,2)+'\n',{mode:0o600});
  const markdown = reportMarkdown(report);
  console.log(markdown);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,markdown);
  console.log('JSON report: '+output);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main().catch((err) => {console.error('Supplier probe: '+err.message);process.exitCode=1;});
