# Parts Engine Architecture

## Purpose
Parts Engine answers the operational question: **what should Roadrunner research, harvest, and work next?**

It is a standalone Next.js/Drizzle application with its own database. It orchestrates facts owned by the surrounding Roadrunner applications instead of absorbing their responsibilities.

## Core discovery flow

```text
fleet inventory
  -> age/generation research priority
  -> unique machine models
  -> supplier BOMs
  -> unique MPNs
  -> eBay market evidence
  -> discovery-worthy MPNs
  -> external fitment expansion
  -> match compatible models against ALL fleet inventory
  -> candidate donor machines
  -> inspect newly discovered donor BOMs
  -> unseen MPNs
  -> research again until no new discovery-worthy MPNs
  -> machine harvest ranking
  -> pull plan / physical harvest downstream
```

Age bands seed the search; they are never a permanent exclusion boundary.

## Application boundaries

### Parts Engine
Owns the discovery graph, imported/cached fleet snapshot, supplier BOM cache, machine/part planning state, research state, decision settings, and teardown ranking.

### EbayDecisions
Owns eBay demand, sold-window, active-competition, price, and market-research evidence. Parts Engine consumes/caches these facts with timestamps and provenance.

### Parts Image Finder
Owns MPN relationship research, external fitment research, and listing-package research. Parts Engine consumes relationship and fitment edges.

### Roadrunner Parts Ledger
Owns physical harvested inventory, SKU/location state, listing publication lifecycle, stock, and realized sales. Donor potential inside an unharvested machine is not Ledger stock.

### Appliance Inventory / App 1
Upstream authority for machine identity/fleet intake once connected. Parts Engine may retain an operational snapshot needed for scoring.

## Evidence separation
Two graph edges that can look similar must remain separate:

- **BOM membership:** supplier evidence that a specific machine model contains an MPN.
- **External fitment:** researched evidence that an MPN is compatible with a model.

Both can match the fleet, but they have different provenance and completeness.

## MPN identity
Canonical key:

```text
trim
-> uppercase
-> remove every character outside A-Z and 0-9
```

The display/raw MPN is preserved. Replacement numbers are linked as relationships; they are not collapsed into one identifier.

## Current integration state
The baseline application moves market facts by CSV and builds fitment from cached supplier BOMs. API integrations are the next stage. CSV remains a supported fallback after APIs are introduced.

## Decision layers
Keep these concepts separate:
- **Research priority:** which models/MPNs deserve expensive research first.
- **Market desirability:** whether an MPN is attractive in the marketplace.
- **Harvest decision:** whether a part is worth pulling from a particular selected donor.
- **Machine disposition:** whole-machine sale vs selective harvest vs scrap/hold. Automatic whole-machine disposition is not implemented yet.
