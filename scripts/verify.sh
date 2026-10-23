#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")/.."
npm ci
npm test -- --run
npm run build
cargo test --locked
cargo fmt --all -- --check
printf '\nCore and frontend checks passed. Native OS acceptance is separate; see docs/acceptance.md.\n'
