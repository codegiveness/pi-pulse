#!/usr/bin/env bash
# Run the pi-pulse test suite from this directory.
set -euo pipefail
cd "$(dirname "$0")"

npm run build
node --test test/*.test.mjs
