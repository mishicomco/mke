#!/usr/bin/env bash
# =============================================================================
#  deploy-app.sh — despliega una app de MKE a un entorno.
#
#  Uso:
#    scripts/deploy-app.sh <app> <local|home|cloud> [tag]
#
#  Ejemplos:
#    scripts/deploy-app.sh hello-mishi local
#    REGISTRY=ghcr.io/OWNER scripts/deploy-app.sh hello-mishi home v0.1.0
#
#  - local : build + `k3d image import` + apply overlay local (no necesita registry).
#  - home  : build + push a $REGISTRY + apply overlay home  (kubectl context mke-home).
#  - cloud : build + push a $REGISTRY + apply overlay cloud (kubectl context mke-cloud).
#
#  Nota: para home/cloud lo RECOMENDADO en MKE es GitOps (Argo/Flux) en vez de un
#  apply imperativo. Este script sirve para bootstrap y para el bucle de local.
# =============================================================================
set -euo pipefail

APP="${1:?uso: deploy-app.sh <app> <local|home|cloud> [tag]}"
TARGET="${2:?uso: deploy-app.sh <app> <local|home|cloud> [tag]}"
TAG="${3:-dev}"

MKE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APPS_ROOT="$(cd "$MKE_ROOT/../mishi-apps" && pwd)"
APP_DIR="$APPS_ROOT/$APP"
OVERLAY="$APP_DIR/k8s/overlays/$TARGET"

[[ -d "$APP_DIR"  ]] || { echo "✗ no existe la app: $APP_DIR" >&2; exit 1; }
[[ -d "$OVERLAY"  ]] || { echo "✗ no existe el overlay: $OVERLAY" >&2; exit 1; }

echo "▶ Desplegando '$APP' a '$TARGET' (tag=$TAG)"

case "$TARGET" in
  local)
    CONTEXT="k3d-mke"
    IMAGE="$APP:dev" # el overlay local referencia :dev
    echo "  • docker build $IMAGE"
    docker build -t "$IMAGE" "$APP_DIR"
    echo "  • k3d image import $IMAGE -c mke"
    k3d image import "$IMAGE" -c mke
    ;;
  home|cloud)
    CONTEXT="mke-$TARGET"
    : "${REGISTRY:?exporta REGISTRY=ghcr.io/OWNER para home/cloud}"
    IMAGE="$REGISTRY/$APP:$TAG"
    echo "  • docker build + push $IMAGE"
    docker build -t "$IMAGE" "$APP_DIR"
    docker push "$IMAGE"
    echo "  ⚠ asegúrate de que el overlay $TARGET apunta a $IMAGE (o usa GitOps)."
    ;;
  *)
    echo "✗ target inválido: $TARGET (usa local|home|cloud)" >&2; exit 1 ;;
esac

echo "  • kubectl --context $CONTEXT apply -k $OVERLAY"
kubectl --context "$CONTEXT" apply -k "$OVERLAY"

echo "  • esperando rollout..."
kubectl --context "$CONTEXT" -n "$APP" rollout status "deploy/$APP" --timeout=120s

echo "✓ Listo. Verifica con:"
echo "    kubectl --context $CONTEXT -n $APP get pods,ingress"
