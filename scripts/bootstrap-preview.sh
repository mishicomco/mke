#!/usr/bin/env bash
# =============================================================================
#  bootstrap-preview.sh — deja INERTE y alcanzable el clúster mke-preview
#  (pc gamer, WSL). Es el clúster SEPARADO de previews efímeros por FEATURE de
#  Studio v2 (un namespace por feature, creado/borrado por `mke preview up/down`).
#  JAMÁS toca mke-prod.
#
#  Idempotente. Crea (si no existen):
#    1. clúster k3d "mke-preview" (12 GiB, sin Traefik embebido)
#    2. Traefik (Helm) en ns "ingress", ClusterIP (modelo tunnel-only)
#    3. túnel Cloudflare "mke-preview" + Secret tunnel-credentials
#    4. cloudflared in-cluster (clusters/preview/cloudflared)
#
#  NO crea DNS. El bootstrap es infra INERTE: cluster + traefik + túnel +
#  cloudflared, sin un solo record. El DNS lo pone/borra cada preview:
#  `mke preview up` crea el CNAME `<feature>-pre.mishi.com.co` -> UUID del túnel
#  con --overwrite-dns (gana sobre el wildcard `*.mishi.com.co`->prod), y
#  `mke preview down` lo borra vía API de Cloudflare (cloudflared no borra DNS).
#
#  PATRÓN VIGENTE: previews con GUIÓN en un solo nivel (`<feature>-pre`), NO el
#  wildcard `*.pre.mishi.com.co` (descartado: el Universal SSL de Cloudflare solo
#  cubre un nivel de subdominio).
#
#  Prerrequisito: cloudflared autenticado (~/.cloudflared/cert.pem).
# =============================================================================
set -euo pipefail

CLUSTER="mke-preview"
CONTEXT="k3d-${CLUSTER}"
TUNNEL="mke-preview"
CF_DIR="${HOME}/.cloudflared"

MKE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREVIEW_DIR="${MKE_ROOT}/clusters/preview"

say() { echo -e "\n▶ $*"; }

# --- 1. Clúster k3d ----------------------------------------------------------
if k3d cluster list 2>/dev/null | grep -qw "${CLUSTER}"; then
  say "Clúster k3d '${CLUSTER}' ya existe — lo arranco si está parado."
  k3d cluster start "${CLUSTER}" || true
else
  say "Creando clúster k3d '${CLUSTER}' (1 nodo, 12 GiB, sin Traefik embebido)."
  k3d cluster create "${CLUSTER}" \
    --servers 1 \
    --k3s-arg "--disable=traefik@server:0" \
    --servers-memory 12G \
    --api-port 127.0.0.1:6444 \
    --wait
fi
kubectl config use-context "${CONTEXT}" >/dev/null

# --- 2. Traefik (Helm) -------------------------------------------------------
say "Instalando/actualizando Traefik en ns 'ingress'."
helm repo add traefik https://traefik.github.io/charts >/dev/null 2>&1 || true
helm repo update traefik >/dev/null
helm upgrade --install traefik traefik/traefik \
  --namespace ingress --create-namespace \
  --kube-context "${CONTEXT}" \
  -f "${PREVIEW_DIR}/traefik-values.yaml" \
  --wait

# --- 3. Túnel Cloudflare (CLI, locally-managed) ------------------------------
if [[ ! -f "${CF_DIR}/cert.pem" ]]; then
  echo "✗ Falta ${CF_DIR}/cert.pem. Ejecuta primero: cloudflared tunnel login" >&2
  exit 1
fi

if cloudflared tunnel list 2>/dev/null | grep -qw "${TUNNEL}"; then
  say "Túnel '${TUNNEL}' ya existe."
else
  say "Creando túnel Cloudflare '${TUNNEL}'."
  cloudflared tunnel create "${TUNNEL}"
fi

TUNNEL_ID="$(cloudflared tunnel list 2>/dev/null | awk -v t="${TUNNEL}" '$2==t {print $1}')"
CREDS_FILE="${CF_DIR}/${TUNNEL_ID}.json"
[[ -f "${CREDS_FILE}" ]] || { echo "✗ No encuentro credenciales: ${CREDS_FILE}" >&2; exit 1; }

# --- 4. Secret + cloudflared in-cluster --------------------------------------
say "Aplicando namespace 'cloudflare' + Secret tunnel-credentials."
kubectl --context "${CONTEXT}" create namespace cloudflare \
  --dry-run=client -o yaml | kubectl --context "${CONTEXT}" apply -f -
kubectl --context "${CONTEXT}" -n cloudflare create secret generic tunnel-credentials \
  --from-file=credentials.json="${CREDS_FILE}" \
  --dry-run=client -o yaml | kubectl --context "${CONTEXT}" apply -f -

say "Desplegando cloudflared in-cluster."
kubectl --context "${CONTEXT}" apply -k "${PREVIEW_DIR}/cloudflared"
kubectl --context "${CONTEXT}" -n cloudflare rollout status deploy/cloudflared --timeout=120s

cat <<EOF

✓ mke-preview INERTE y listo (sin DNS).
   Contexto:  ${CONTEXT}
   Túnel:     ${TUNNEL} (${TUNNEL_ID})

El DNS lo maneja cada preview:
   mke preview up  <app> <rama>     # crea <feature>-pre.mishi.com.co -> túnel
   mke preview down <feature>       # borra el CNAME + el namespace
   mke preview ls                   # lista los previews vivos

Verifica la cadena (sin DNS aún, un 404 de Traefik confirma el túnel):
   kubectl --context ${CONTEXT} -n cloudflare get pods
EOF
