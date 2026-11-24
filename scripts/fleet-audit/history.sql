-- Start from state AND event tables. Unlisting can remove the current state.
-- Each historical event remains a separate dated record even if the edge is gone.
with history as (
  select machine_no, mpn_canonical, 'state' as origin, null::text as event_id,
    state as action, disposition, null::text as previous_disposition,
    sold_price::text, null::text as previous_sold_price, repair_machine_no,
    updated_at::text as recorded_at, null::boolean as applied
  from machine_part_state
  union all
  select machine_no, mpn_canonical, 'disposition', id::text, step, next_disposition,
    previous_disposition, sold_price::text, previous_sold_price::text, repair_machine_no,
    recorded_at::text, true from machine_part_disposition_events
  union all
  select machine_no, mpn_canonical, 'fleet_part_event', id::text, kind,
    null, null, null, null, other_machine, observed_at::text, applied
  from fleet_part_events where nullif(mpn_canonical, '') is not null
)
select h.*, case when f.machine_no is null then 'machine missing'
  when e.mpn_canonical is null then 'unmatched historical MPN'
  when m.mpn_canonical is null then 'MPN master missing'
  else 'current edge' end as edge_match
from history h left join fleet_machines f using (machine_no)
left join model_part_edges e on e.brand_key = f.brand_key and e.model_key = f.model_key
  and e.mpn_canonical = h.mpn_canonical
left join mpn_master m on m.mpn_canonical = h.mpn_canonical
order by h.machine_no, h.mpn_canonical, h.origin, h.event_id
