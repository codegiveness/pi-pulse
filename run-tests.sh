#!/usr/bin/env bash
# Run the pi-pulse test suite from this directory.
# `npm test` runs the `pretest` hook (build) then the test runner.
set -euo pipefail
cd "$(dirname "$0")"

npm test
