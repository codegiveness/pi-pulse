# Getting started

## Install from npm

```bash
pi install npm:pi-pulse
```

Or add `npm:pi-pulse` to `~/.pi/agent/settings.json` under the `packages` key:

```json
{
  "packages": ["npm:pi-pulse"]
}
```

> **Security note:** Pi extensions run with the same permissions as your Pi process. Only install from sources you trust. This package is published with npm [provenance](https://docs.npmjs.com/generating-provenance-statements/) so you can verify that the tarball was built from this repository.

## Build from source

```bash
npm install
npm run build
npm test
```

The TypeScript source compiles to `dist/`. `package.json#pi.extensions` tells Pi to load the compiled entry point.

## Local development install

1. Clone or copy this repository.
2. Add the source extension to `~/.pi/agent/settings.json`:

   ```json
   {
     "extensions": ["/path/to/pi-pulse/src/extension.ts"]
   }
   ```
3. Disable the stock `pi-tps-meter` extension if it is enabled.
4. Reload Pi with `/reload`.

## Run the tests

```bash
npm test
```

`npm test` runs `npm run build` automatically (`pretest`) and then executes every `test/*.test.mjs` file with Node's built-in test runner. If you prefer the shell runner, you can also run `./run-tests.sh`.

## Verify the install

Start a Pi session and ask the assistant a question. The footer should show something like:

```text
TPS ⣤⣸⠀⠀⠀⠀⠀⠀ 42 avg | μ 38 | p10 25 | p95 55 | TTFT μ 0.25s | Elapsed 15s
```

If you only see `Elapsed`, that means there are no recent TPS/TTFT samples yet — usually because the current responses are too short or have decode phases below the 0.3 s suppression threshold.

For what those numbers mean, see [`metrics.md`](./metrics.md).
