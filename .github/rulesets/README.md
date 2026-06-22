# Repository rulesets

This directory contains exported GitHub Repository Rulesets for backup and review.

## `protect-version-tags`

Applies to tags matching `refs/tags/v*` and prevents tag deletion and non-fast-forward updates.

## `main` branch

There is no Repository Ruleset for `main`. It is protected with the classic branch protection API:
- Required status checks: `Test (Node 20)`, `Test (Node 22)`, `Test (Node 24)` (strict)
- Required pull request reviews: 1 approving review
- Require linear history
- No force pushes or deletions
