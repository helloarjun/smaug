# Personal Smaug setup and archive

Snapshot: September 12, 2026.

This is the helloarjun fork. Local `origin` points to `helloarjun/smaug`;
`upstream` points to the original `alexknowshtml/smaug` repository.

## Personal archive

- Eight local archive commits were made during March 9–20, 2026.
- The cleaned archive contains 102 unique primary Tweet IDs, including inherited
  examples and personal additions. Two entries without a primary Tweet URL are
  retained without inventing an ID.
- Cleanup consolidated 185 primary Tweet fields into 102: 83 repeated entries.
  Distinct older descriptions remain in expandable context sections. Every URL
  from the pre-cleanup archive is preserved, and date sections are ordered newest first.
- Seven personal notes are included: Agentation, DesEngs, Droid task management,
  Marc Andreessen's information consumption, builder-skills, Craft Agents, and
  a starter guide to NYC tech.

## Local-only state

At inspection, the local queue contained 100 pending bookmarks, last generated
on March 20, 2026. Configuration, Twitter credentials, pending state, and batch
backups remain gitignored and are not included in this PR.

Historical setup notes recorded testing Bird, Claude Haiku, and OpenCode models,
and correcting selection of an outdated Claude executable. Those observations
are historical, not current provider compatibility or pricing guarantees.

## Separate safety work

[PR #1](https://github.com/helloarjun/smaug/pull/1) contains the processing safety
changes and review fixes. On that branch and the local checkout, AI is explicitly
disabled by default. This archive-only PR does not independently implement the
cost gate; merging the safety PR is required to obtain that behavior on main.

No LLM calls or bookmark fetches were made during this archive cleanup.
