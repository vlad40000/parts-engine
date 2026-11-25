-- Only allow-listed identity and catalog fields. Start at Fleet so every status
-- and every record with a missing nameplate or cache entry survives the joins.
with edge_counts as (
  select brand_key, model_key, count(*)::int as edge_count
  from model_part_edges group by brand_key, model_key
), model_spellings as (
  select brand_key, model_key,
    count(distinct (upper(trim(brand)), upper(trim(model_raw))))::int as spellings
  from fleet_machines where model_key <> '' group by brand_key, model_key
)
select f.machine_no, f.availability, f.brand, f.model_raw, f.serial, f.identity_status,
  f.age_candidate_years, f.age_confidence, coalesce(s.spellings, 0) as model_spellings,
  b.brand_display, b.model_display, b.status as cache_status, b.source, b.source_url,
  b.fetched_at::text as fetched_at, b.row_count, b.dropped_rows,
  coalesce(e.edge_count, 0) as edge_count,
  d.source_sha256 as diagram_digest
from fleet_machines f
left join model_bom_cache b using (brand_key, model_key)
left join edge_counts e using (brand_key, model_key)
left join model_spellings s using (brand_key, model_key)
left join model_diagrams d on d.brand_key = f.brand_key and d.exact_model = upper(trim(f.model_raw))
order by f.machine_no
