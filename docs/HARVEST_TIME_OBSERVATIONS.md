# Measured harvest-time observations

Settings > Advanced > Measure actual harvesting time (optional).

Enter a fleet machine ID with verified identity and completed matching BOM, the measurement date, shared cabinet/access time once per session, and 1–30 exact MPNs with separately timed incremental removal and inspection/testing. Input time unit: minutes. Example: `W10721967,4,2`.

An observation is not proof a part is physically present or salable, and does not update `machine_part_state` or Roadrunner Parts Ledger. A timestamped historical record is saved, not a new removal-time baseline; changing an operational per-MPN number still requires the owner's explicit action.

No modeled/repair guide time is copied into economics, and the original seed file remains unchanged.

**Deploy migration before the code path.** Migration `0003_harvest_time_observations` creates two separate tables without touching `removal_baselines`, `mpn_master`, fees or prices. Test with disposable database before production. This slice intentionally does not include Opus v2 baseline replacements (see REMOVAL_TIME_OPUS_V2_REVIEW.md).
