# Shared settings for the ports build scripts (sourced). Override with the environment.
#   TEHBOXEN  repo root (default: the parent of ports/)
#   WORK      scratch for downloads and checkouts (default: $TEHBOXEN/.ports-work, gitignored)
#   WASI_SDK  wasi-sdk install (default: $WORK/wasi-sdk-34.0-x86_64-linux, fetched by ports/wasi-sdk.sh)
set -e
PORTS=$(cd "$(dirname "$0")" && pwd)
while [ ! -f "$PORTS/env.sh" ] && [ "$PORTS" != / ]; do PORTS=$(dirname "$PORTS"); done
TEHBOXEN=${TEHBOXEN:-$(cd "$PORTS/.." && pwd)}
WORK=${WORK:-$TEHBOXEN/.ports-work}
WASI_SDK_VERSION=34.0
WASI_SDK=${WASI_SDK:-$WORK/wasi-sdk-$WASI_SDK_VERSION-x86_64-linux}
mkdir -p "$WORK"
