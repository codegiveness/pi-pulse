# pi-pulse

## 0.4.1

### Patch Changes

- Security: resolve 3 transitive dependency vulnerabilities by raising `package.json#overrides` floors and bumping devDependencies.

  - `brace-expansion` ≥ 5.0.7 (high — GHSA-3jxr-9vmj-r5cp, DoS via exponential-time expansion)
  - `js-yaml` ≥ 4.3.0 (high — GHSA-52cp-r559-cp3m, quadratic CPU on merge-key chains)
  - `protobufjs` ≥ 7.6.5 (moderate — GHSA-j3f2-48v5-ccww, infinite loop in .proto option parsing)

  DevDependency bumps (via Dependabot PR #20):

  - `@earendil-works/pi-coding-agent` 0.80.2 → 0.80.10
  - `typescript` 6.0.3 → 7.0.2
  - `@changesets/cli` 2.31.0 → 2.31.1

  `npm audit` now reports 0 vulnerabilities. No package behavior change — the published tarball is unchanged from 0.4.0 aside from the version bump.
