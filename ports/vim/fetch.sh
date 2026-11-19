#!/bin/sh
# Recreate our vim fork: upstream at VIM_COMMIT + patches/*.patch, in $WORK/vim.
. "$(dirname "$0")/../env.sh"
SRC=$WORK/vim
COMMIT=$(cat "$PORTS/vim/VIM_COMMIT")
if [ ! -d "$SRC/.git" ]; then git clone -q https://github.com/vim/vim.git "$SRC"; fi
cd "$SRC"
git fetch -q origin "$COMMIT" 2>/dev/null || true
git checkout -q -f "$COMMIT"
git clean -qfdx
for p in "$PORTS"/vim/patches/*.patch; do git apply "$p"; done
