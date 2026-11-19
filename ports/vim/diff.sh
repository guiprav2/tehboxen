#!/bin/sh
# After editing the fork in $WORK/vim, save the changes back as patches/0001-wasi.patch.
. "$(dirname "$0")/../env.sh"
cd "$WORK/vim" && git diff > "$PORTS/vim/patches/0001-wasi.patch"
