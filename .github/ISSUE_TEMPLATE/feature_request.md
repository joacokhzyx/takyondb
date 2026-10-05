---
name: Feature request
about: Propose something, and say what would prove it wrong
labels: enhancement
---

## The problem

Not the feature. The situation that makes you want it, and who is paying
today. A feature with no problem behind it is usually a preference, and
preferences are worth having once they are named as such.

## Which gate

The roadmap is seven gates, and each has an exit criterion. Mark the one
this belongs to. If none of them fits, that is worth arguing about before
anyone writes code, because it means either the roadmap is wrong or the
idea is out of scope.

- [ ] Gate 1, substrate: regions and capacities decided at startup
- [ ] Gate 2, durability: an explicit commit and real back-pressure
- [ ] Gate 3, cache: TTL, eviction, volatile writes
- [ ] Gate 4, relational in the arena
- [ ] Gate 5, energy measurement
- [ ] Gate 6, language surfaces

## What would falsify it

The part that usually goes unwritten. What measurement would show that
this change did not achieve what it claims, or that it cost more than it
returned? If the answer is "no measurement would", say what you would
accept as evidence anyway.

## Cost

What it displaces. An arena bump word is a fixed address mirrored in two
languages; a delta tag is a write-path contract; a snapshot format change
cannot be converted in place. Proposals that ignore this get scheduled and
then break on disk.

## Alternatives considered

Including "do nothing" and "the caller keeps doing it by hand". A proposal
with one option on the table is not a proposal.
