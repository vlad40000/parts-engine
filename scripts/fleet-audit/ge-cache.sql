-- Compare the parts as printed, even if a legacy edge was keyed by an alias.
select e.mpn_display, e.mpn_canonical, e.diagram_id, e.source,
  b.source_url, b.brand_display, b.model_display, b.status as cache_status
from model_part_edges e left join model_bom_cache b using (brand_key, model_key)
where e.brand_key = 'GE' and e.model_key = 'GTD42EASJ2WW'
order by e.mpn_canonical
