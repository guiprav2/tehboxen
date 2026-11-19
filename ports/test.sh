#!/bin/sh
# Smoke tests for the built ports (run after build.sh/package.sh): each case runs the WASI
# binary on the host and compares its output. Networking/terminal behavior is browser-only.
#   sh ports/test.sh [busybox|vim|…]
. "$(dirname "$0")/env.sh"
set +e
RUN="node --experimental-wasm-exnref --no-warnings $PORTS/test/run-wasi.mjs"
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
cd "$T"
pass=0; fail=0
check() { # name expected actual
  if [ "$2" = "$3" ]; then pass=$((pass + 1)); else fail=$((fail + 1)); printf 'FAIL %s\n  want: %s\n  got:  %s\n' "$1" "$2" "$3"; fi
}
want() { [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }
ONLY=$1

if want busybox; then
  BB="$WORK/busybox/busybox_unstripped"
  bb() { a=$1; shift; $RUN "$BB" "$a" "$@"; }
  check busybox:awk "a 3" "$(echo 'b a c' | bb awk '{print $2, NF}')"
  check busybox:sort "z m a" "$(printf 'm\nz\na\n' | bb sort -r | tr '\n' ' ' | sed 's/ $//')"
  check busybox:gzip "hello zip" "$(echo 'hello zip' | bb gzip -c | bb gzip -dc)"
  check busybox:bzip2 "hello bz" "$(echo 'hello bz' | bb bzip2 -c | bb bzip2 -dc)"
  echo data > f.txt
  # (tar -z creation needs the runtime's dup(): browser-only)
  bb tar cf t.tar f.txt || true
  check busybox:tar "f.txt" "$(bb tar tf t.tar 2>&1)"
  check busybox:sha256 "$(sha256sum f.txt | cut -d' ' -f1)" "$(bb sha256sum f.txt | cut -d' ' -f1)"
  check busybox:base64 "hi" "$(echo hi | bb base64 | bb base64 -d)"
  check busybox:sed "hXllo" "$(echo hello | bb sed 's/e/X/')"
  check busybox:expr "42" "$(bb expr 40 + 2)"
  check busybox:applet-from-argv0 "3" "$(printf 'a\nb\nc\n' | $RUN "$BB" /usr/bin/wc -l)"
fi

if want vim; then
  VIM="$WORK/vim/src/vim"
  echo hello > v.txt
  $RUN "$VIM" vim -u NONE -n -es '+%s/hello/HI/' '+wq' v.txt
  check vim:ex-substitute "HI" "$(cat v.txt)"
fi

if want xz; then
  XZ="$WORK/xz/src/xz/xz"
  check xz:roundtrip "hello xz" "$(echo 'hello xz' | $RUN "$XZ" xz -c | $RUN "$XZ" xz -dc)"
  # Interop with the host's xz both ways.
  check xz:host-decodes "$(seq 1 3000 | md5sum)" "$(seq 1 3000 | $RUN "$XZ" xz -6 | xz -dc | md5sum)"
  check xz:decodes-host "$(seq 1 3000 | md5sum)" "$(seq 1 3000 | xz -9 | $RUN "$XZ" xz -dc | md5sum)"
  check xz:lzma "lz" "$(echo lz | $RUN "$XZ" lzma | $RUN "$XZ" unlzma)"
  # -k: x.txt stays, x.txt.xz appears (fchmod of the copy is checked in the browser).
  echo keep > x.txt
  $RUN "$XZ" xz -k x.txt
  check xz:keep "keep keep" "$(cat x.txt) $(xz -dc x.txt.xz)"
fi

if want zip || want unzip; then
  ZIP="$WORK/zip/zip"
  UNZIP="$WORK/unzip/unzip"
  mkdir -p zd/sub && seq 1 2000 > zd/n.txt && echo hi > zd/sub/a.txt
  $RUN "$ZIP" zip -qr "$T/t.zip" zd
  check zip:host-unzip "No errors detected in compressed data of t.zip." "$(unzip -t t.zip | tail -1)"
  check zip:stdin "piped" "$(echo piped | $RUN "$ZIP" zip -q "$T/p.zip" - && unzip -p p.zip)"
  check zip:encrypt "2000" "$($RUN "$ZIP" zip -q -e -P s3cret "$T/e.zip" zd/n.txt && unzip -P s3cret -p e.zip | tail -1)"
  zip -qr host.zip zd
  check unzip:list "4 files" "$($RUN "$UNZIP" unzip -l "$T/host.zip" | tail -1 | sed 's/.* \([0-9]* files\)/\1/')"
  mkdir ux && (cd ux && $RUN "$UNZIP" unzip -q "$T/host.zip" 2>/dev/null)
  check unzip:extract "$(md5sum < zd/n.txt)" "$(md5sum < ux/zd/n.txt)"
  check unzip:pipe "hi" "$($RUN "$UNZIP" unzip -p "$T/host.zip" zd/sub/a.txt)"
  check unzip:encrypted "2000" "$($RUN "$UNZIP" unzip -P s3cret -p "$T/e.zip" | tail -1)"
fi

if want openssl; then
  OSSL="$RUN $WORK/openssl/apps/openssl openssl"
  check openssl:sha256 "$(printf abc | sha256sum | cut -d' ' -f1)" "$(printf abc | $OSSL dgst -sha256 | sed 's/.*= //')"
  printf '[req]\ndistinguished_name=dn\n[dn]\n[ca]\nbasicConstraints=critical,CA:true\nkeyUsage=critical,keyCertSign\n' > "$T/min.cnf"
  $OSSL req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout "$T/ca.key" -out "$T/ca.crt" -subj /CN=T -days 9 -config "$T/min.cnf" -extensions ca 2>/dev/null
  $OSSL req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout "$T/l.key" -out "$T/l.csr" -subj /CN=l -config "$T/min.cnf" 2>/dev/null
  $OSSL x509 -req -in "$T/l.csr" -CA "$T/ca.crt" -CAkey "$T/ca.key" -days 9 -out "$T/l.crt" 2>/dev/null
  # The host's openssl accepts what ours issued.
  check openssl:ca-issue "l.crt: OK" "$(openssl verify -CAfile ca.crt l.crt 2>&1)"
fi

if want wget; then
  check wget:version "GNU Wget 1.25.0 built on wasi." "$($RUN "$WORK/wget/src/wget" wget --version | head -1)"
  check wget:https "+https" "$($RUN "$WORK/wget/src/wget" wget --version | grep -o '+https')"
fi

if want curl; then
  check curl:openssl "OpenSSL/3.5.9" "$($RUN "$WORK/curl/src/curl" curl --version | head -1 | grep -o 'OpenSSL/[0-9.]*')"
  echo filedata > "$T/c.txt"
  check curl:file "filedata" "$($RUN "$WORK/curl/src/curl" curl -s "file://$T/c.txt")"
fi

if want uacme; then
  check uacme:version "uacme: version 1.8.1" "$($RUN "$WORK/uacme/uacme" uacme -V 2>&1 | head -1)"
fi

echo "ports/test.sh: $pass passed, $fail failed"
[ "$fail" = 0 ]
