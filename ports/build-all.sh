#!/bin/sh
# Rebuild every prebuilt WASI artifact under toolchain/ from ports/.
. "$(dirname "$0")/env.sh"
"$PORTS/wasi-sdk.sh"
"$PORTS/libtehboxen/build.sh"
"$PORTS/wasi-threads-sysroot/build.sh"
"$PORTS/vim/fetch.sh"
"$PORTS/vim/build.sh"
"$PORTS/vim/package.sh"
