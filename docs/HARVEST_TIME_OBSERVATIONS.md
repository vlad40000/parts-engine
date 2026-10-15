# Measured harvest-time observations

Settings > Advanced > Measure actual harvesting time (optional).

Enter a fleet machine ID with verified identity and completed matching BOM, the measurement date, shared cabinet/access time once per session, and 1–30 exact MPNs with separately timed incremental removal and inspection/testing. Input time unit: minutes. Example: `W10721967,4,2`.

Displayed Whirlpool service-pack numbers are accepted only through a stored `wp_prefix` alias whose target is the exact completed-BOM identity and matches the existing WP import rule. No prefix is removed without that evidence. Supersession and variant relationships do not qualify. Duplicate rows resolving to the same BOM identity are rejected before writing. Each observation preserves the entered MPN in `mpn_display` alongside its resolved BOM identity.

An observation is not proof a part is physically present or salable, and does not update `machine_part_state` or Roadrunner Parts Ledger. A timestamped historical record is saved, not a new removal-time baseline; changing an operational per-MPN number still requires the owner's explicit action.

No modeled/repair guide time is copied into economics, and the original seed file remains unchanged.

**Deploy migration before the code path.** Migration `0003_harvest_time_observations` creates two separate tables without touching `removal_baselines`, `mpn_master`, fees or prices. Test with disposable database before production. This slice intentionally does not include Opus v2 baseline replacements (see REMOVAL_TIME_OPUS_V2_REVIEW.md).

Migration 0003 remains unreleased and includes the entered-MPN column and explicitly named foreign keys matching its Drizzle snapshot. A disposable database that already ran an earlier PR revision must be recreated before acceptance; the migration runner does not replay edited migrations. Production migration, merge and deployment each require the owner's separate authorization.

Settings distinguishes invalid dates/times, duplicate identities, and completed-BOM validation errors from database failures. When the observation tables or entered-MPN column are missing, the optional measurement panel displays a database-update message and disables recording. Other Settings remain available. Raw database messages and queries are never displayed.
