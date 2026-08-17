#!/usr/bin/env bash
# Actualiza el mke de la fabrica CI: pull de MAIN del forge + deps si cambio el lock.
set -euo pipefail
export PATH=/usr/local/bin:/usr/bin:/bin
cd /home/mke-ci/mke
antes=$(md5sum cli/package-lock.json | cut -d" " -f1)
git fetch -q origin && git reset -q --hard origin/main
[ "$antes" = "$(md5sum cli/package-lock.json | cut -d" " -f1)" ] || (cd cli && npm ci --silent)
