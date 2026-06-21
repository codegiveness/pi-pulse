# Contributing to pi-pulse

Thank you for helping improve pi-pulse.

## Development setup

```bash
npm install
npm run typecheck
npm run build
npm test
```

Before committing, the release checklist is:

- `npm run typecheck` passes.
- `npm run build` passes.
- `npm test` passes.
- README / docs are updated if user-visible behavior changed.

See [`testing.md`](./testing.md) for more detail on the test suite.

## Making changes

1. Open an issue first for large features or bug reports.
2. Keep changes minimal and focused to the behavior you are changing.
3. Follow the existing TypeScript style (`strict: true`, `noUnusedLocals: true`).
4. Do not store mutable state in module-level variables — each extension load gets its own `StatsMeter` instance.
5. If you add an event handler, update the README, the regression tests, and [`architecture.md`](./architecture.md).
6. Read [`AGENTS.md`](../AGENTS.md) for project-specific behavioral guidelines.

## Changesets

pi-pulse uses [Changesets](https://github.com/changesets/changesets) to manage releases.

If your PR is user-facing, run:

```bash
npx changeset
```

or, on filesystems that do not support symlinks:

```bash
node node_modules/@changesets/cli/bin.js
```

Commit the generated `.changeset/*.md` file. The Changesets workflow will open a version-packages PR when a release is ready.

## Attribution

This project was originally inspired by [`pi-tps-meter`](https://github.com/vskrch/pi-tps-meter) by vskrch. Please respect upstream authorship when reusing concepts or documentation from third-party projects.
