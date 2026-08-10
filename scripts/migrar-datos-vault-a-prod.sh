#!/usr/bin/env bash
# Migra los DATOS del vault (BD `vault_mishi`) de stage (pc gamer,
# databases-dev) a prod (laptop, databases) — parte del corte que vuelve a
# prod autónomo (2026-08-07). Los valores viajan cifrados con la KEK (la BD
# solo guarda ciphertext); nada se imprime.
#
# Prerrequisitos: vault-mishi DESPLEGADO en prod (schema migrado por su Job) y
# la KEK sembrada en el Secret de prod. Idempotente: TRUNCATE + data-only.
#
# Uso: migrar-datos-vault-a-prod.sh

set -euo pipefail

SRC_CTX=k3d-mke-gamer;   SRC_NS=databases-dev  # (one-shot ya corrida 2026-08; contexto actualizado al nombre nuevo)
DST_CTX=mke-prod-laptop; DST_NS=databases
DB=vault_mishi

echo "1/3 tablas en destino (schema debe existir por el deploy):"
TABLAS="$(kubectl --context $DST_CTX -n $DST_NS exec -i postgres-0 -- \
  psql -U postgres -d $DB -At -c "select tablename from pg_tables where schemaname='public'")"
[ -n "$TABLAS" ] || { echo "sin tablas en $DB de prod — ¿corrió el deploy/migraciones?" >&2; exit 1; }
echo "$TABLAS" | sed 's/^/  /'

echo "2/3 TRUNCATE en destino + restore data-only desde stage…"
LISTA="$(echo "$TABLAS" | sed 's/^/public."/; s/$/"/' | paste -sd, -)"
kubectl --context $DST_CTX -n $DST_NS exec -i postgres-0 -- \
  psql -U postgres -d $DB -q -c "TRUNCATE TABLE $LISTA CASCADE"
kubectl --context $SRC_CTX -n $SRC_NS exec -i postgres-0 -- \
  pg_dump -U postgres --data-only --disable-triggers --exclude-schema=drizzle -d $DB \
  | kubectl --context $DST_CTX -n $DST_NS exec -i postgres-0 -- \
      psql -U postgres -d $DB -q -v ON_ERROR_STOP=1 >/dev/null

echo "3/3 conteos origen vs destino:"
for t in $(echo "$TABLAS"); do
  a=$(kubectl --context $SRC_CTX -n $SRC_NS exec -i postgres-0 -- psql -U postgres -d $DB -At -c "select count(*) from public.\"$t\"")
  b=$(kubectl --context $DST_CTX -n $DST_NS exec -i postgres-0 -- psql -U postgres -d $DB -At -c "select count(*) from public.\"$t\"")
  marca=OK; [ "$a" = "$b" ] || marca=DIFIEREN
  printf '  %-24s origen=%-6s destino=%-6s %s\n' "$t" "$a" "$b" "$marca"
done
