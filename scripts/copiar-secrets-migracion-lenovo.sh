#!/usr/bin/env bash
# copiar-secrets-para-santi.sh — corre SANTI desde el pc gamer.
# Copia TODOS los Secrets de app/plataforma del cluster prod del laptop
# (contexto mke-laptop) al cluster del lenovo (contexto mke-lenovo),
# máquina a máquina — ningún valor pasa por terminal/chat.
# Usa el patrón de mke/scripts/copiar-claves-secret-k8s.sh pero secret completo.
# El de cloudflare/tunnel-credentials NO se copia (el lenovo tiene túnel propio).
set -euo pipefail
SRC=mke-laptop
DST=mke-lenovo
for par in \
  prod/artifact-mishi-secrets prod/block-mishi-secrets prod/chrome-mishi-secrets \
  prod/content-factory-secrets prod/dropshipping-mishi-secrets prod/flipping-mishi-secrets \
  prod/iam-mishi-secrets prod/identity-mishi-secrets prod/links-mishi-secrets \
  prod/marketing-mishi-secrets prod/memoria-mishi-secrets prod/mishi-bank-secrets \
  prod/omni-mishi-secrets prod/omni-whatsapp-secrets prod/postgrest-flota-config \
  prod/recolor-secrets prod/travelhabit-meta prod/vault-mishi-secrets \
  artifact/artifact-mishi-secrets iam-emisor/iam-emisor ; do
  ns=${par%%/*}; s=${par##*/}
  kubectl --context $SRC -n $ns get secret $s -o json \
    | python3 -c "
import json,sys
d=json.load(sys.stdin)
m={'apiVersion':'v1','kind':'Secret','type':d.get('type','Opaque'),
   'metadata':{'name':d['metadata']['name'],'namespace':d['metadata']['namespace']},
   'data':d.get('data',{})}
print(json.dumps(m))" \
    | kubectl --context $DST apply -f - >/dev/null
  echo "✔ $ns/$s"
done
echo "LISTO — todos los secrets copiados al lenovo."
