#!/bin/sh
# Package zip (after build.sh); bump its version in other/packages.js afterwards.
exec sh "$(dirname "$0")/../infozip-package.sh" zip zip zipcloak zipnote zipsplit
