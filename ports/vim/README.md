# vim

Vim 9.2 at `VIM_COMMIT`, built for wasm32-wasip1 with wasi-sdk and
libtehboxen, packaged with `xxd` and a runtime subset (syntax, ftplugin,
indent, autoload, colors, plugin, compiler, pack; no syntax test suite, keymaps or GUI menus, no docs but
help.txt, no spell/tutor/translations). Installed as the `vim` system
package (`/usr/local/bin/{vim,vi,view,ex,vimdiff,rvim,xxd}`,
`/usr/local/share/vim/vim92`).

`patches/0001-wasi.patch`:
- `os_unix.c`: timeouts never fire (WASI has no timers/signals; only regexp
  and redraw time limits use them); no TIOCGWINSZ (size comes from
  LINES/COLUMNS, set by the runner); no `term_set_winsize` without termcap.
- `term.c`: the fallback `tgoto()` (no termcap library) also evaluates
  terminfo parameter strings, used by the builtin xterm entry (mouse modes).

Build: `fetch.sh`, `build.sh`, `package.sh` (see ../README.md). Vim is
charityware: `LICENSE.vim`; modified copies ship with these patches.

## Extras

`extras/` is packaged on top of the upstream runtime (`package.sh`):

- `extras/colors/`: the molokai (tomasr/molokai) and monokai (sickill/vim-monokai)
  colorschemes, MIT, with their licenses and source commits in `SOURCES`.
- `extras/vimrc`: the system vimrc (`/usr/local/share/vim/vimrc`): `syntax on`,
  `filetype plugin indent on`, `termguicolors` under a truecolor `$COLORTERM`, and
  `colorscheme molokai`. `~/.vimrc` loads after it, so `colorscheme monokai` there switches.
