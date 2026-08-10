#!/usr/bin/env bash
# =============================================================================
#  bootstrap-gamer.sh — levanta el clúster mke-gamer en el PC gamer (WSL).
#
#  Un solo cluster POR MÁQUINA (ley 2026-08-10): el gamer corre `mke-gamer`
#  con namespaces `stage` + `preview` (+ plataforma stage: databases-dev,
#  storage-stage, git-stage, mesh-central). Cambia solo configuración,
#  nunca código (overlays Kustomize / manifests de cada repo de plataforma).
#
#  Idempotente: se puede correr varias veces. Crea (si no existen):
#    0. sysctl de inotify (sin esto un 2º/3º cluster k3s NO arranca:
#       "inotify_init: too many open files" — lección 2026-08-10)
#    1. clúster k3d "mke-gamer" (contexto kubectl: k3d-mke-gamer, host:80→lb)
#    2. Traefik (Helm) en ns "ingress" (clusters/prod/traefik-values.yaml,
#       con allowCrossNamespace para los artifacts)
#    3. túnel Cloudflare "mke-gamer" + Secret tunnel-credentials
#    4. cloudflared in-cluster (clusters/prod/cloudflared con tunnel: mke-gamer)
#    5. registry local por nodo (registry-mishi/bootstrap)
#
#  La plataforma stage (postgres/minio/forgejo/mesh) y las apps se restauran
#  desde sus repos + backups de Drive: ver postgres-mishi/backups/RESTORE.md.
#
#  Prerrequisitos: WSL con systemd, Docker, k3d, helm, kubectl, cloudflared
#  YA autenticado (~/.cloudflared/cert.pem).
# =============================================================================
set -euo pipefail

CLUSTER="mke-gamer"
CONTEXT="k3d-${CLUSTER}"
TUNNEL="mke-gamer"
CF_DIR="${HOME}/.cloudflared"

MKE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROD_DIR="${MKE_ROOT}/clusters/prod"

say() { echo -e "\n▶ $*"; }

# --- 0. límites de inotify (persistentes) ------------------------------------
if [[ ! -f /etc/sysctl.d/90-mke-inotify.conf ]]; then
  say "Subiendo límites de inotify (k3s los agota y el cluster no arranca)."
  sudo sh -c 'printf "fs.inotify.max_user_instances=1024\nfs.inotify.max_user_watches=2097152\n" > /etc/sysctl.d/90-mke-inotify.conf && sysctl -p /etc/sysctl.d/90-mke-inotify.conf'
fi

# --- 1. Clúster k3d ----------------------------------------------------------
if k3d cluster list 2>/dev/null | grep -qw "${CLUSTER}"; then
  say "Clúster k3d '${CLUSTER}' ya existe — lo arranco si está parado."
  k3d cluster start "${CLUSTER}" || true
else
  say "Creando clúster k3d '${CLUSTER}' (1 nodo, sin Traefik embebido, host:80→lb)."
  k3d cluster create "${CLUSTER}" \
    --servers 1 \
    --port "80:80@loadbalancer" \
    --k3s-arg "--disable=traefik@server:0" \
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
  -f "${PROD_DIR}/traefik-values.yaml" \
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

say "Desplegando cloudflared in-cluster (config del túnel ${TUNNEL})."
kubectl --context "${CONTEXT}" apply -k "${PROD_DIR}/cloudflared"
kubectl --context "${CONTEXT}" -n cloudflare rollout status deploy/cloudflared --timeout=120s

# --- 5. Registry local por nodo ----------------------------------------------
say "Registry local (registry-mishi)."
bash "${MKE_ROOT}/../registry-mishi/bootstrap/bootstrap-registry-nodo.sh" "${CLUSTER}"

# --- 6. Namespaces de trabajo ------------------------------------------------
for ns in stage preview; do
  kubectl --context "${CONTEXT}" create namespace "$ns" \
    --dry-run=client -o yaml | kubectl --context "${CONTEXT}" apply -f -
done

cat <<EOF

✓ mke-gamer listo.
   Contexto:   ${CONTEXT}
   Túnel:      ${TUNNEL} (${TUNNEL_ID})
   Namespaces: stage, preview (+ plataforma a restaurar por repo)

Siguiente: plataforma stage (postgres-mishi, minio-mishi, git-mishi, mesh)
y apps vía \`mke deploy <app> stage\`. DNS por host: \`mke dns <host> stage\`.
EOF
