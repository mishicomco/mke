#!/usr/bin/env bash
# flip-dns-lenovo.sh [--volver] [host ...]
# Flipea los CNAME del corte al túnel del lenovo (912ca3b0) o de vuelta al
# laptop (421fe55c) con --volver. Sin hosts explícitos usa la lista completa.
set -euo pipefail
LENOVO=912ca3b0-fb97-460a-a43b-0a02892e19a8.cfargotunnel.com
LAPTOP=421fe55c-649e-4df2-baec-7273bd8b7e17.cfargotunnel.com
TARGET=$LENOVO; [ "${1:-}" = "--volver" ] && { TARGET=$LAPTOP; shift; }
DNS=$(~/.local/bin/mpe secret get mpe/cloudflare-dns)
API=https://api.cloudflare.com/client/v4
LISTA=$(dirname "$0")/hosts-migracion-lenovo.txt
declare -A ZID
zid() { # cache zone id por nombre
  local zn=$1
  if [ -z "${ZID[$zn]:-}" ]; then
    ZID[$zn]=$(curl -s -H "Authorization: Bearer $DNS" "$API/zones?name=$zn" | python3 -c "import json,sys;print(json.load(sys.stdin)['result'][0]['id'])")
  fi
  echo "${ZID[$zn]}"
}
flip_uno() {
  local zn=$1 host=$2 z rid
  z=$(zid $zn)
  rid=$(curl -s -H "Authorization: Bearer $DNS" "$API/zones/$z/dns_records?type=CNAME&name=$host" | python3 -c "import json,sys;r=json.load(sys.stdin)['result'];print(r[0]['id'] if r else '')")
  [ -n "$rid" ] || { echo "?? $host sin registro"; return; }
  ok=$(curl -s -X PATCH -H "Authorization: Bearer $DNS" -H "Content-Type: application/json" \
    "$API/zones/$z/dns_records/$rid" -d "{\"content\":\"$TARGET\"}" | python3 -c "import json,sys;print(json.load(sys.stdin)['success'])")
  echo "$host -> ${TARGET%%.*} ($ok)"
}
if [ $# -gt 0 ]; then
  for h in "$@"; do
    zn=$(awk -v h=$h '$2==h{print $1}' $LISTA); [ -n "$zn" ] || zn=mishi.com.co
    flip_uno $zn $h
  done
else
  while read -r zn host; do flip_uno $zn $host; done < $LISTA
fi
