#!/usr/bin/env bash
# Crea la identidad CI del vault para UN NODO de la flota (laptop, pc futuro…)
# y escribe su token a un archivo 0600. Variante parametrizada de
# crear-identidad-vault-mke.sh (fija al pc gamer): cada nodo runner tiene SU
# identidad, revocable sin tocar a los demás.
#
# Igual que el original: grants leer+escribir sobre los ns de las apps. Además
# `leer` sobre el ns `santi` — mke deploy lee `git-mishi-npm-token` y
# `cloudflare-dns-api` de ahí vía vault-mishi (en el gamer eso lo cubre el
# token humano de Santi; un nodo runner no lo tiene). DEUDA conocida: el grant
# del vault es por namespace, no por secreto.
#
# REGLA DE ORO: ningún valor de secreto se imprime jamás.
#
# Uso:  bash scripts/crear-identidad-vault-nodo.sh <identidad> <archivo-token>
#   ej: bash scripts/crear-identidad-vault-nodo.sh mke-runner-deploy-laptop /tmp/t

set -uo pipefail

IDENTIDAD="${1:?uso: crear-identidad-vault-nodo.sh <identidad> <archivo-token>}"
TOKEN_FILE="${2:?uso: crear-identidad-vault-nodo.sh <identidad> <archivo-token>}"
VAULT_URL="${VAULT_URL:-https://vault.mishi.com.co}"
# Raiz de confianza en el store GPG offline `~/.config/mishi/secrets/` (el repo
# secrets-mishi fue borrado 2026-08-08; se lee con `gpg` crudo).
GPG_STORE="$HOME/.config/mishi/secrets"
gpg_get() {
  gpg --batch --quiet --passphrase-file "$GPG_STORE/.passphrase" \
    --decrypt "$GPG_STORE/$1.gpg" 2>/dev/null \
    | sed -E '1s/^[[:space:]]*api_key:[[:space:]]*//' | tr -d '\r\n'
}

NAMESPACES="barrio-mishi block-mishi chrome-mishi content-factory dropshipping-mishi
flipping-mishi git-mishi hola-mishi identity-mishi images-mishi links-mishi
mahjong-mishi marketing-mishi memoria-mishi minio-mishi mishi-bank mishi-studio
omni-mishi omni-whatsapp polla-futbolera postgres-mishi recolor static-mishi
status-mishi travelhabitco vault-mishi"

ROOT="$(gpg_get vault-root-token)" || { echo "no pude leer vault-root-token del GPG" >&2; exit 1; }
[ -n "$ROOT" ] || { echo "vault-root-token vacio" >&2; exit 1; }

resp="$(curl -s -w '\n%{http_code}' -X POST "$VAULT_URL/v1/identidad" \
  -H "Authorization: Bearer $ROOT" -H 'content-type: application/json' \
  -d "{\"nombre\":\"$IDENTIDAD\",\"tipo\":\"ci\"}")"
code="$(printf '%s' "$resp" | tail -n1)"
body="$(printf '%s' "$resp" | sed '$d')"
if [ "$code" != "201" ]; then
  unset ROOT
  echo "crear identidad fallo: HTTP $code (¿ya existe? el vault no re-crea por nombre)" >&2
  exit 1
fi

ID="$(printf '%s' "$body" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).id))')"
mkdir -p "$(dirname "$TOKEN_FILE")"
umask 077
printf '%s' "$body" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).token))' > "$TOKEN_FILE"
chmod 600 "$TOKEN_FILE"
unset body resp
echo "identidad $IDENTIDAD creada (id $ID); token en $TOKEN_FILE (0600)"

for ns in $NAMESPACES santi; do
  for permiso in leer escribir; do
    [ "$ns" = santi ] && [ "$permiso" = escribir ] && continue
    c=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$VAULT_URL/v1/grant" \
      -H "Authorization: Bearer $ROOT" -H 'content-type: application/json' \
      -d "{\"identidadId\":\"$ID\",\"namespace\":\"$ns\",\"permiso\":\"$permiso\"}")
    [ "$c" = "201" ] || echo "  grant $permiso/$ns → HTTP $c" >&2
  done
done
unset ROOT
echo "grants: $(echo $NAMESPACES | wc -w) ns de apps (leer+escribir) + santi (solo leer)"
