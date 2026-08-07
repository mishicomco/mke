#!/usr/bin/env bash
# Copia CLAVES elegidas de un Secret k8s de un cluster/ns a otro, máquina a
# máquina — los valores jamás pasan por la terminal ni por logs. Herramienta de
# migración de servicios de plataforma entre nodos de la flota (ej. la KEK del
# vault al mover vault-mishi de stage/gamer a prod/laptop, 2026-08-07).
#
# El Secret destino se MERGEA con `kubectl apply` sobre un manifiesto que solo
# trae las claves pedidas (las demás claves existentes se conservan si el
# Secret ya existía vía strategic merge de apply? NO — apply reemplaza data).
# Por eso: si el Secret destino YA existe, este script usa `kubectl patch`
# clave por clave para no pisar el resto.
#
# Uso: copiar-claves-secret-k8s.sh <ctx-origen> <ns-origen> <ctx-destino> <ns-destino> <nombre-secret> <clave> [clave...]

set -euo pipefail

CTX_SRC="${1:?ctx origen}"; NS_SRC="${2:?ns origen}"
CTX_DST="${3:?ctx destino}"; NS_DST="${4:?ns destino}"
NOMBRE="${5:?nombre del secret}"; shift 5
[ $# -ge 1 ] || { echo "faltan claves" >&2; exit 1; }

DATA="$(kubectl --context "$CTX_SRC" -n "$NS_SRC" get secret "$NOMBRE" -o json)"

if kubectl --context "$CTX_DST" -n "$NS_DST" get secret "$NOMBRE" >/dev/null 2>&1; then
  for clave in "$@"; do
    B64="$(printf '%s' "$DATA" | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['$clave'],end='')")"
    kubectl --context "$CTX_DST" -n "$NS_DST" patch secret "$NOMBRE" --type merge \
      -p "{\"data\":{\"$clave\":\"$B64\"}}" >/dev/null
    echo "clave $clave → patch en $CTX_DST/$NS_DST"
  done
else
  printf '%s' "$DATA" | python3 -c "
import json,sys
claves=sys.argv[1:]
d=json.load(sys.stdin)['data']
m={'apiVersion':'v1','kind':'Secret',
   'metadata':{'name':'$NOMBRE','namespace':'$NS_DST'},
   'type':'Opaque','data':{k:d[k] for k in claves}}
print(json.dumps(m))" "$@" | kubectl --context "$CTX_DST" apply -f - >/dev/null
  echo "secret $NOMBRE creado en $CTX_DST/$NS_DST con: $*"
fi
kubectl --context "$CTX_DST" -n "$NS_DST" get secret "$NOMBRE" -o jsonpath='{.data}' \
  | python3 -c "import json,sys;print('claves ahora:',sorted(json.load(sys.stdin).keys()))"
