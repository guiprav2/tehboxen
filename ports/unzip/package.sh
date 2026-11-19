#!/bin/sh
# Package unzip (after build.sh): unzip, funzip, zipinfo (= unzip -Z via argv0). Bump its
# version in other/packages.js afterwards.
exec sh "$(dirname "$0")/../infozip-package.sh" unzip unzip funzip zipinfo=unzip
