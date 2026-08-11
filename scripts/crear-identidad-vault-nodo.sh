#!/usr/bin/env bash
# Crea la identidad CI del vault para UN NODO de la flota (laptop, pc futuro…)
# y escribe su token a un archivo 0600. Variante parametrizada de
# crear-identidad-vault-mke.sh (fija al pc gamer): cada nodo runner tiene SU
# identidad, revocable sin tocar a los demás.
#
# Grants sobre los ns de las apps: `leer` SIN patrón (MATERIALIZAR lee las claves
# arbitrarias de cada app — residual aceptado, ver RUNBOOK-fabrica-aislada.md
# §Prueba de fuego) y `escribir` ACOTADA a `DATABASE_URL__*` (mke SOLO escribe eso
# al provisionar la BD). Además `leer` sobre el ns `santi` — mke deploy lee
# `git-mishi-npm-token` y `cloudflare-dns-api` de ahí (en el gamer eso lo cubre el
# token humano de Santi; un nodo runner no lo tiene).
#
# El patrón de escritura NO es opcional: sin él la identidad puede sobrescribir
# CUALQUIER clave de esos ns (hallazgo de la prueba de fuego 2026-08-11, acotado
# a mano en los nodos vivos). Un nodo nuevo DEBE nacer ya acotado — no re-introducir
# el over-grant. El grant del vault es por namespace + patrón de clave.
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
    # escritura ACOTADA a DATABASE_URL__* (mke solo escribe eso); lectura sin patrón.
    cuerpo="{\"identidadId\":\"$ID\",\"namespace\":\"$ns\",\"permiso\":\"$permiso\""
    [ "$permiso" = escribir ] && cuerpo="$cuerpo,\"patron\":\"DATABASE_URL__*\""
    cuerpo="$cuerpo}"
    c=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$VAULT_URL/v1/grant" \
      -H "Authorization: Bearer $ROOT" -H 'content-type: application/json' \
      -d "$cuerpo")
    [ "$c" = "201" ] || echo "  grant $permiso/$ns → HTTP $c" >&2
  done
done
unset ROOT
echo "grants: $(echo $NAMESPACES | wc -w) ns de apps (leer sin patrón + escribir DATABASE_URL__*) + santi (solo leer)"
