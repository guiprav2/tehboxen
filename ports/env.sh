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
# Link flags every libtehboxen program needs (the in-browser clang driver, other/node/clang.js,
# passes the same): keep the cwd-init constructor, and route stat/getsockopt/accept/ioctl/dup
# chmod through libtehboxen's wrappers.
TB_LDFLAGS="-Wl,--export=__tehboxen_init -Wl,--wrap=stat,--wrap=lstat,--wrap=fstat,--wrap=fstatat,--wrap=getsockopt,--wrap=accept,--wrap=accept4,--wrap=ioctl,--wrap=dup,--wrap=dup2,--wrap=dup3,--wrap=chmod,--wrap=fchmod,--wrap=fchmodat"
# autoconf: functions libtehboxen provides (see config.site).
export CONFIG_SITE="$PORTS/config.site"
