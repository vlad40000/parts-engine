# Removal-time research: Opus 5.5 v2 review (proposed, not active)

The owner supplied an independently developed v2 removal-time model. It starts from a closed, unplugged, free-standing donor and estimates *standalone* extraction minutes using modeled access-path steps, 60 seconds of handling, and a 1.6 allowance. It proposes 242 components (143 retained labels + 99 new) and platform-specific paths. This is promising for future calibration **but is not a published table of measured per-MPN harvest times**.

## Integration decision
- **Accepted now:** cited repair references as optional read-only guidance; record actual access/removal/testing durations per machine and exact BOM MPN, without inventory or economics side effects.
- **Deferred pending owner approval and stopwatch calibration:** 143 baseline minute replacements, nine existing MPN override updates, six proposed new overrides, automatic seed synchronization, broader part-family classifier changes, the v2 migration `0003_removal_library_v2`, and any contribution-per-labor-minute ranking.
- **Migration conflict:** this PR uses `0003_harvest_time_observations` on the current `0002` migration head. If adopting Opus v2 later, regenerate its migration and journal at the then-current head rather than copying its `0003` files.
- **Quantitative caution:** the Opus proposal reports 699 versus 1586 summed minutes for the existing 143 components (roughly 40% of original). That is a material cost change, so do not substitute these values until tested.
- **Safety:** microwave high-voltage work requires qualified technicians, and timer data is not a work instruction.

## Useful source categories (supplied report)
- Marconi et al. (2019), *Applying data mining technique to disassembly sequence planning*: https://air.unipr.it/bitstream/11381/2848083/9/2018-04-15_Manuscript.pdf — empirical component disassembly and element-time anchors.
- Sears PartsDirect repair help: https://www.searspartsdirect.com/diy/repair-help — instructions and repair-time ceilings, NOT standalone harvest durations.
- PartSelect https://www.partselect.com/ and Fix.com https://www.fix.com/ — reported repair-time buckets, teardown steps and model-specific access paths.
- JRC washing-machine and dishwasher reparability report: https://eplca.jrc.ec.europa.eu/uploads/JRC_report-Durability_Reusability_Reparability_V05-draft.pdf — qualitative access constraints.

Published guide figures, proposed modeled estimates, and shop stopwatch observations are three distinct evidence classes.
