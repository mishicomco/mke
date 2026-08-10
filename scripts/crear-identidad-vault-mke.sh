#!/usr/bin/env bash
# Crea (UNA sola vez) la identidad `mke-runner-deploy` en el vault-mishi y le da
# grants de LECTURA + ESCRITURA sobre los namespaces de las apps del ecosistema.
#
# Por que existe: desde 2026-07-28 el Secret k8s `<app>-secrets` es DERIVADO del
# vault (`mke deploy` fase MATERIALIZAR). El CLI necesita una identidad propia
# tipo `ci` — jamas el token root, que vive SOLO en el GPG offline y no se usa a
# diario.
#
# NOTA sobre el alcance de escritura: el modelo de grants del vault es por
# NAMESPACE (no por nombre de secreto), asi que el grant `escribir` alcanza todo
# el ns. `mke` se AUTO-LIMITA por codigo a escribir unicamente
# `DATABASE_URL__<env>` (unico secreto del que mke es dueno: el provisiona la BD).
# Si el vault llega a soportar grants por nombre, acotar aca.
#
# REGLA DE ORO: ningun valor de secreto (ni el root, ni el nuevo token) se
# imprime jamas. El token nuevo se escribe a un archivo 0600.
#
# Uso:  bash scripts/crear-identidad-vault-mke.sh
# Idempotente: si el archivo de token ya existe y funciona, no hace nada.

set -uo pipefail

VAULT_URL="${VAULT_URL:-https://vault.mishi.com.co}"
TOKEN_FILE="${VAULT_DEPLOY_TOKEN_FILE:-$HOME/.config/mishi/vault-mke.token}"
# Identidad POR NODO (`mke-runner-deploy@<nodo>`): el nombre es UNICO en el vault
# desde la migracion 0003 y grantDeploy otorga a TODA la familia
# `mke-runner-deploy`+`mke-runner-deploy@*` — cada runner con su token, sin
# homonimos (post-mortem iam-mishi 2026-08-09).
IDENTIDAD="${MKE_VAULT_IDENTIDAD:-mke-runner-deploy@$(hostname)}"
# Raiz de confianza: el token root NO vive en el vault que protege, sino en el
# store GPG offline `~/.config/mishi/secrets/`. El repo secrets-mishi fue borrado
# (2026-08-08); se lee con `gpg` crudo, no con un CLI externo.
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

# ── 0) ¿ya funciona? ──────────────────────────────────────────────────────────
if [ -f "$TOKEN_FILE" ]; then
  tok="$(cat "$TOKEN_FILE")"
  code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $tok" \
    "$VAULT_URL/v1/secretos/mishi-bank")
  unset tok
  if [ "$code" = "200" ]; then
    echo "ya existe y funciona: $TOKEN_FILE (identidad $IDENTIDAD)"
    exit 0
  fi
  echo "el token de $TOKEN_FILE no autentica (HTTP $code) — recreando identidad" >&2
fi

# ── 1) token root, SOLO en memoria ────────────────────────────────────────────
ROOT="$(gpg_get vault-root-token)" || { echo "no pude leer vault-root-token del GPG" >&2; exit 1; }
[ -n "$ROOT" ] || { echo "vault-root-token vacio" >&2; exit 1; }

# ── 2) identidad tipo ci ──────────────────────────────────────────────────────
resp="$(curl -s -w '\n%{http_code}' -X POST "$VAULT_URL/v1/identidad" \
  -H "Authorization: Bearer $ROOT" -H 'content-type: application/json' \
  -d "{\"nombre\":\"$IDENTIDAD\",\"tipo\":\"ci\"}")"
code="$(printf '%s' "$resp" | tail -n1)"
body="$(printf '%s' "$resp" | sed '$d')"
if [ "$code" != "201" ]; then
  unset ROOT
  echo "crear identidad fallo: HTTP $code (¿ya existe? el vault no permite re-crear por nombre)" >&2
  exit 1
fi

ID="$(printf '%s' "$body" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).id))')"
mkdir -p "$(dirname "$TOKEN_FILE")"
umask 077
printf '%s' "$body" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).token))' > "$TOKEN_FILE"
chmod 600 "$TOKEN_FILE"
unset body resp
echo "identidad $IDENTIDAD creada (id $ID); token en $TOKEN_FILE (0600)"

# ── 3) grants leer + escribir por namespace ───────────────────────────────────
for ns in $NAMESPACES; do
  for permiso in leer escribir; do
    c=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$VAULT_URL/v1/grant" \
      -H "Authorization: Bearer $ROOT" -H 'content-type: application/json' \
      -d "{\"identidadId\":\"$ID\",\"namespace\":\"$ns\",\"permiso\":\"$permiso\"}")
    [ "$c" = "201" ] || echo "  grant $permiso/$ns → HTTP $c" >&2
  done
done
unset ROOT
echo "grants aplicados sobre $(echo $NAMESPACES | wc -w) namespaces"
