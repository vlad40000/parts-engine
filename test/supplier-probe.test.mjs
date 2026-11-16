import { describe, expect, it } from 'vitest';
import {
  CASES, PROVIDERS, normalized, exactModelToken, modelIdentity, allowedHost,
  findDlPartsModelUrl, extractPageEvidence, probeOne, compareToBaseline, runProbes
} from '../scripts/supplier-probe.mjs';

const model = CASES.find((v) => v.machine === '5713');
const htmlPage = (modelNumber = model.model, brand = model.brand, content = '') =>
  '<!doctype html><html><head><title>' + brand + ' ' + modelNumber +
  ' Washer Replacement Parts</title></head><body><h1>' + brand + ' ' + modelNumber +
  ' Washer Parts</h1>' + content + '</body></html>';
const fake = (html,opts = {}) => async (url) =>
  ({ok:true,status:200,finalUrl:url,html,elapsedMs:2,...opts});

describe('read-only supplier probe boundaries', () => {
  it('uses exactly six known models and five providers, no inventory writes', () => {
    expect(CASES).toHaveLength(6);
    expect(PROVIDERS).toEqual(['partselect','partsdr','sears','coast','dlparts']);
    expect(CASES.map((v) => v.machine)).toEqual(['5712','5713','6605','2121','6660','58-1']);
  });
  it('normalizes MPNs but retains the original display value', () => {
    expect(normalized(' dc47-00019a ')).toBe('DC4700019A');
    expect(normalized('W10256514')).not.toBe(normalized('W10247710'));
  });
  it('requires exact model and compatible manufacturer in heading or title', () => {
    expect(exactModelToken('Maytag MVWB755YQ0 washer',model.model)).toBe(true);
    expect(exactModelToken('Maytag MVWB755YQ00 washer',model.model)).toBe(false);
    expect(modelIdentity(htmlPage('MVWB755YQ00'),model)).toBe('unresolved');
    expect(modelIdentity(htmlPage(model.model,'Samsung'),model)).toBe('unresolved');
    expect(modelIdentity(htmlPage(),model)).toBe('confirmed');
  });
  it('forbids redirects outside the target supplier domain', () => {
    expect(allowedHost('https://www.partselect.com/Models/MVWB755YQ0/','partselect')).toBe(true);
    expect(allowedHost('https://evilpartselect.com/Models/MVWB755YQ0/','partselect')).toBe(false);
    expect(allowedHost('https://www.appliancepartspros.com/parts-for-maytag-mvwb755yq0.html','partselect')).toBe(false);
  });
  it('extracts OEMs but excludes PartSelect retail PS IDs', () => {
    const evidence = extractPageEvidence(htmlPage(model.model,model.brand,
      '<div data-oem-part-number="W10247710">Suspension Kit</div>' +
      '<div data-oem-part-number="PS2355518">Retail-only identifier</div>'
    ),'partselect');
    expect(evidence.parts.map((v) => v.canonical)).toEqual(['W10247710']);
  });
  it('does not fabricate MPNs by joining Sears part numbers to stock/status text', () => {
    const sample = htmlPage(model.model,model.brand,
      '<div>Part #72017In Stock</div><div>Part #350930This item ships</div>');
    const evidence = extractPageEvidence(sample,'sears');
    expect(evidence.parts).toEqual([]);
  });
  it('parses Coast diagram table and sourced replacements without collapsing identities', () => {
    const evidence = extractPageEvidence(htmlPage(model.model,model.brand,
      '<table><tbody><tr><td>10</td><td>W10247710</td><td>Suspension (Replaces: W10256514)</td></tr></tbody></table>'
    ),'coast');
    expect(evidence.parts).toMatchObject([{canonical:'W10247710',replaces:['W10256514']}]);
  });
  it('never claims completeness from a model page, even with part rows', async () => {
    const result = await probeOne(model,'coast',fake(htmlPage(model.model,model.brand,
      '<table><tbody><tr><td>10</td><td>W10247710</td><td>Suspension Kit</td></tr></tbody></table>')));
    expect(result).toMatchObject({outcome:'sample_parts_found',identity:'confirmed',
      coverage:'sample',sectionsFetched:0,observedCount:1});
  });
  it('retains 403 as blocked without parsing or treating as not_found', async () => {
    const result = await probeOne(model,'sears',fake('',{ok:false,status:403}));
    expect(result).toMatchObject({outcome:'blocked_403',observedParts:[],coverage:'unknown'});
  });
  it('refuses unrelated brand and does not propose MPN differences', async () => {
    const result = await probeOne(model,'partselect',fake(htmlPage(model.model,'Samsung',
      '<div>Part #W10247710</div>')));
    const compared = compareToBaseline([result],{models:[{brand:model.brand,model:model.model,mpns:[]}]});
    expect(compared[0]).toMatchObject({outcome:'identity_unresolved',candidateMissingFromApp:[]});
  });
  it('proposes missing MPNs for review, never new donor links', async () => {
    const result = await probeOne(model,'coast',fake(htmlPage(model.model,model.brand,
      '<table><tbody><tr><td>10</td><td>W10247710</td><td>Suspension Kit</td></tr>' +
      '<tr><td>11</td><td>WP285655</td><td>Clamp</td></tr></tbody></table>')));
    const compared = compareToBaseline([result],{models:[{brand:model.brand,model:model.model,mpns:['WP285655']}]});
    expect(compared[0]).toMatchObject({comparisonStatus:'sample_only_review_required',
      candidateMissingFromApp:['W10247710'],baselineMpnCount:1});
  });
  it('never infers an absent exact-model URL as lack of compatible parts', async () => {
    const range = CASES.find((v) => v.machine === '6660');
    const result = await probeOne(range,'coast',fake(''));
    expect(result.outcome).toBe('no_verified_url');
  });
  it('requires an unambiguous D&L model detail link and refuses wrong choices', () => {
    const search = '<a href="/lookup/12345?site=prod-standard">MVWB755YQ0</a>' +
      '<a href="/lookup/67890?site=prod-standard">MVWB755YQ00</a>';
    expect(findDlPartsModelUrl(search,model,'https://www.dlpartscolookup.com/lookup'))
      .toBe('https://www.dlpartscolookup.com/lookup/12345?site=prod-standard');
    expect(findDlPartsModelUrl('<a href="/lookup/99">MVWB755YQ00</a>',model,
      'https://www.dlpartscolookup.com/lookup')).toBeNull();
  });
  it('follows a uniquely identified D&L detail page, with no database access', async () => {
    const calls = [];
    const fetcher = async (url) => {
      calls.push(url);
      const html = url.includes('lookup?') ? '<a href="/lookup/12345">MVWB755YQ0</a>' :
        htmlPage(model.model,model.brand,
          '<h2 class="diagram">Top and Cabinet</h2><table class="table"><tbody><tr>' +
          '<td class="itemNumber">10</td><td class="partNumber">W10247710</td>' +
          '<td class="description">Suspension Damper Kit</td></tr></tbody></table>');
      return {ok:true,status:200,finalUrl:url,html};
    };
    const result = await probeOne(model,'dlparts',fetcher);
    expect(calls).toHaveLength(2);
    expect(result).toMatchObject({outcome:'sample_parts_found',observedCount:1,coverage:'sample'});
  });
  it('does not fetch live URLs when a test fetcher is injected', async () => {
    const results = await runProbes([model],['partselect','partsdr'],fake(htmlPage()));
    expect(results).toHaveLength(2);
    expect(results.every((v) => v.outcome === 'model_confirmed_no_oem_rows')).toBe(true);
  });
});
