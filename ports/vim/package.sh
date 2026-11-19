#!/bin/sh
# Package vim + xxd + runtime as toolchain/vim/vim-9.2-wasm32-wasip1.tgz (after build.sh).
# Bump the version in other/packages.js afterwards so existing boxes reinstall.
. "$(dirname "$0")/../env.sh"
SDK=$WASI_SDK
V=$WORK/vim
B=$WORK/vim-bundle
R=$B/package/usr/local/share/vim/vim92
rm -rf "$B"
mkdir -p "$B/package/usr/local/bin" "$R/doc"
$SDK/bin/llvm-strip -o "$B/package/usr/local/bin/vim" "$V/src/vim"
$SDK/bin/llvm-strip -o "$B/package/usr/local/bin/xxd" "$V/src/xxd/xxd"
chmod 755 "$B/package/usr/local/bin/"*
cd "$V/runtime"
# No docs (but help.txt), spell files, tutor or translations: the rest is what editing needs.
cp -r *.vim syntax ftplugin indent autoload colors plugin compiler pack "$R/"
cp doc/help.txt "$R/doc/"
cp "$V/LICENSE" "$R/LICENSE"
# Trim what this build can't use: the syntax test suite (~2.8k files), keyboard keymaps,
# GUI menus, and optional packages that need features we leave out (terminal, clientserver,
# GUI, docs). Every syntax/ftplugin/indent/compiler file stays.
rm -rf "$R/syntax/testdir" "$R/keymap"
rm -f "$R/menu.vim" "$R/synmenu.vim" "$R/makemenu.vim" "$R/delmenu.vim" "$R/mswin.vim" "$R/macmap.vim" "$R/evim.vim" "$R/gvimrc_example.vim"
for p in termdebug shellmenu swapmouse dvorak editexisting helptoc helpcurwin; do rm -rf "$R/pack/dist/opt/$p"; done
# Extras: monokai/molokai colorschemes and a system vimrc (syntax on, filetype plugins, molokai).
X=$PORTS/vim/extras
cp "$X/colors/"*.vim "$R/colors/"
mkdir -p "$R/colors/licenses" && cp "$X/colors/LICENSE."* "$X/colors/SOURCES" "$R/colors/licenses/"
cp "$X/vimrc" "$B/package/usr/local/share/vim/vimrc"
find "$B/package/usr/local/share" -type f -exec chmod 644 {} +
cd "$B"
mkdir -p "$TEHBOXEN/toolchain/vim"
tar czf "$TEHBOXEN/toolchain/vim/vim-9.2-wasm32-wasip1.tgz" --owner=0 --group=0 --sort=name package
