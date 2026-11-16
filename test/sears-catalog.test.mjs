import {describe,expect,it} from 'vitest';
import {
  extractSearsCatalogPayload,parseSearsCatalogPage,reconcileSearsPages
} from '../scripts/sears-catalog.mjs';
const toHtml=(db)=>'<!doctype html><html><head><title>Maytag MVWB755YQ0 washer</title></head>'+
  '<body><script>window.__TEST__ = {"CATALOG_API_RESPONSE":'+JSON.stringify(db)+'};</script></body></html>';
const make=(number='MVWB755YQ0',total=2,partNumbers=['W10256514'])=>{
  const db={
    ROOT_QUERY:{'model({"id":"5xlr0pc0dk-003048"})':{__ref:'Model:1'}},
    'Model:1':{__typename:'Model',id:'5xlr0pc0dk-003048',number,
      hasParts:true,brand:{__ref:'Brand:1'},
      'parts({"page":1})':{totalCount:total,parts:partNumbers.map((n)=>({__ref:'Part:'+n}))},
      'schematics({"page":1})':{schematics:[{__ref:'Schematic:top'}]}},
    'Brand:1':{__typename:'Brand',name:'Maytag'},
    'Schematic:top':{__typename:'Schematic',id:'top',pageName:'Top and Cabinet Parts'},
    'Part:W10247710':{__typename:'Part',number:'W10247710'},
  };
  for(const part of partNumbers){
    db['Part:'+part]={__typename:'Part',id:part,number:part,
      title:part==='W10256514'?'Suspension':'Other washer part',
      contextSchematicTitle:'Top and Cabinet Parts',contextSchematicKeyId:'10',
      substitutedByList:{parts:part==='W10256514'?[{__ref:'Part:W10247710'}]:[]}};
  }
  return db;
};
describe('Sears catalog JSON parser — source provenance and completeness',()=>{
  it('finds balanced JSON containing escaped quotation marks',()=>{
    const db=make();
    db['Part:W10256514'].title='Suspension "heavy duty"';
    expect(extractSearsCatalogPayload(toHtml(db))).toEqual(db);
  });
  it('does not infer a catalog from unrelated site scripts',()=>{
    expect(extractSearsCatalogPayload('<script>window.x={"parts":["W10247710"]};</script>')).toBeNull();
  });
  it('requires the precise model identity and never mistakes another revision',()=>{
    const wrong=parseSearsCatalogPage(make('MVWB755YQ00'),'MVWB755YQ0');
    expect(wrong.status).toBe('identity_mismatch');
    expect(wrong.parts).toEqual([]);
  });
  it('reads exact original MPN, records replacement independently with diagram position',()=>{
    const page=parseSearsCatalogPage(make(),'MVWB755YQ0');
    expect(page).toMatchObject({status:'model_page_parsed',expectedCount:2,observedCount:1,
      model:{number:'MVWB755YQ0',brand:'Maytag'},
      parts:[{original:'W10256514',canonical:'W10256514',section:'Top and Cabinet Parts',
        diagramKey:'10',replacedBy:['W10247710']}],
      schematics:[{id:'top',title:'Top and Cabinet Parts'}]});
  });
  it('refuses unresolved part references as complete',()=>{
    const db=make();
    db['Model:1']['parts({"page":1})'].parts.push({__ref:'Part:unknown'});
    const page=parseSearsCatalogPage(db,'MVWB755YQ0');
    expect(page.status).toBe('partial_unresolved_refs');
    expect(page.invalidReferences).toBe(1);
  });
  it('reconciles bounded paginated source and never treats one page as complete',()=>{
    const first=parseSearsCatalogPage(make('MVWB755YQ0',2,['W10256514']),'MVWB755YQ0');
    const second=parseSearsCatalogPage(make('MVWB755YQ0',2,['WPW10178988']),'MVWB755YQ0');
    expect(reconcileSearsPages([first],1)).toMatchObject({status:'incomplete_sample',
      coverage:'partial',expectedCount:2,observedCount:1,remainingExpected:1});
    const complete=reconcileSearsPages([first,second],2);
    expect(complete).toMatchObject({status:'page_count_reconciled',
      coverage:'complete_for_sears',expectedCount:2,observedCount:2});
    expect(complete.parts.map((p)=>p.original)).toEqual(['W10256514','WPW10178988']);
  });
  it('never claims complete if the same page is returned for page 2',()=>{
    const page=parseSearsCatalogPage(make('MVWB755YQ0',2,['W10256514']),'MVWB755YQ0');
    expect(reconcileSearsPages([page,page],2)).toMatchObject({status:'incomplete_sample',
      observedCount:1,remainingExpected:1});
  });
  it('never considers a mismatched later page complete',()=>{
    const good=parseSearsCatalogPage(make('MVWB755YQ0',2,['W10256514']),'MVWB755YQ0');
    const bad=parseSearsCatalogPage(make('MVWB755YQ00',2,['WPW10178988']),'MVWB755YQ0');
    expect(reconcileSearsPages([good,bad],2)).toMatchObject({status:'incomplete_sample',
      rejectedPages:1,observedCount:1});
  });
});
