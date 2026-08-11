# RUNBOOK — cerrar el Hallazgo 0 (operador robable) · corte en vivo

> **Sucesor (2026-08-10): `RUNBOOK-emisor.md`.** Este runbook sacó el operador
> del ns de apps a `iam-operador`, PERO el runner seguía portando el operador
> (super-poder). El corte a EMISOR (residual #1) lo cierra: el runner pasa a un
> emisor de mínimo privilegio y el operador sale del cluster por completo. Si
> arrancas de cero, corre este primero y luego `RUNBOOK-emisor.md`; si el Hallazgo
> 0 ya está aplicado, salta directo a `RUNBOOK-emisor.md`.

Lo hace **Santi** (no CI). Toca secrets reales y RBAC del cluster. Orden EXACTO:
crear el operador en su nueva casa → apuntar el pod al hash → RBAC del runner →
verificar → recién ahí retirar lo viejo. Cada paso dice qué rompe si se saltea.

Contexto: `mke-gamer` (stage) y `mke-laptop` (prod) son clusters SEPARADOS. Haz
TODO en uno, verifícalo, y repite en el otro. Los manifiestos referidos:
`iam-mishi/k8s/platform/*` y `mke/clusters/rbac/*`.

## 0. Antes de tocar nada
- Ten a mano el token de operador vigente: `OP="$(vault-mishi get iam-mishi/IAM_OPERADOR_TOKEN__<env>)"`.
- Calcula su hash: `OPHASH="$(printf %s "$OP" | sha256sum | cut -d' ' -f1)"` → 64 hex.
  Verifica que es el MISMO token con el que hoy opera el CLI (`IAM_ENV=<env> iam-mishi ls` funciona).

## 1. Mover el token de operador al vault-ns dedicado
`mke deploy` materializa al Secret k8s `iam-mishi-secrets` **TODAS** las claves del
ns de vault `iam-mishi` (no solo las declaradas: "el vault MANDA", las no
declaradas se materializan igual con WARN). Por eso el CLARO del operador NO puede
seguir en `iam-mishi`: ahí lo re-materializa cada deploy. Va a un ns de vault
DEDICADO (`iam-operador`) y en `iam-mishi` queda solo el HASH.

El vault es **APPEND-ONLY** (no existe `vault-mishi rm`) y todos los `set` toman el
valor por **STDIN**:

```
printf %s "$OP"                       | vault-mishi set iam-operador/IAM_OPERADOR_TOKEN__<env>
printf %s "$OPHASH"                   | vault-mishi set iam-mishi/IAM_OPERADOR_TOKEN_SHA256__<env>
# No se puede BORRAR la clave vieja del claro en iam-mishi → se ROTA a un valor
# INERTE (marcador). Al no poder rm, esta es la defensa DURABLE (no el kubectl
# patch, que reaparece al próximo deploy):
printf %s "RETIRADO-ver-iam-operador" | vault-mishi set iam-mishi/IAM_OPERADOR_TOKEN__<env>
```
Por qué el marcador inerte es INOFENSIVO aunque mke lo materialice: el pod usa
SOLO `IAM_OPERADOR_TOKEN_SHA256` (bootstrap por hash — ver deployment.yaml) y el
CLI humano lee el claro REAL de `iam-operador` (cli/iam-mishi). Nadie usa ya
`iam-mishi/IAM_OPERADOR_TOKEN`, así que su valor materializado es basura sin poder.
Si te salteas la rotación a inerte: el claro real seguiría aterrizando en
`iam-mishi-secrets` en cada deploy — el Hallazgo 0 NO se cierra de forma durable.

## 2. Crear el namespace + Secret del operador (fuera del ns de apps)
```
kubectl --context <ctx> apply -f iam-mishi/k8s/platform/operador-namespace.yaml
TOKEN="$(vault-mishi get iam-operador/IAM_OPERADOR_TOKEN__<env>)"
kubectl --context <ctx> -n iam-operador create secret generic iam-operador \
  --from-literal=IAM_OPERADOR_TOKEN="$TOKEN"
```
Invariante que NO se puede violar: `sha256(IAM_OPERADOR_TOKEN de este Secret)`
DEBE ser igual a `IAM_OPERADOR_TOKEN_SHA256` del vault iam-mishi. Si difieren,
tras el paso 3 iam-mishi sembrará una credencial cuyo hash NADIE porta → el CLI
y `mke deploy` quedan sin operador (401).

## 3. Redeploy de iam-mishi con el hash (el pod deja de ver el claro)
La rama `iam-manifiesto` ya trae el código (bootstrap por hash) y el manifiesto
(`IAM_OPERADOR_TOKEN_SHA256`). Con ella en main:
```
mke deploy iam-mishi <env>
```
Verifica: el pod arranca y `IAM_OPERADOR_TOKEN_SHA256` está en el Secret. La clave
`IAM_OPERADOR_TOKEN` SIGUE presente (mke materializa TODAS las claves del ns), pero
su VALOR ya es el marcador inerte — confírmalo:
```
kubectl -n <apps-ns> get secret iam-mishi-secrets -o jsonpath='{.data.IAM_OPERADOR_TOKEN}' | base64 -d
# → "RETIRADO-ver-iam-operador" (basura sin poder; el pod usa solo el hash)
```
`IAM_ENV=<env> iam-mishi ls` sigue funcionando (el CLI lee el claro real de
`iam-operador`; el hash sembrado casa con él). Si te salteaste la rotación a inerte
del paso 1, aquí reaparece el claro REAL en el Secret de apps.

## 4. RBAC del runner (dejar de usar cluster-admin)
```
kubectl --context <ctx> apply -f mke/clusters/rbac/mke-deploy-sa.yaml
kubectl --context <ctx> apply -f mke/clusters/rbac/operador-access.yaml
# Role del ns de apps: edita metadata.namespace y el RoleBinding.namespace a
# `stage` (gamer) o `prod` (laptop) antes de aplicar.
kubectl --context <ctx> apply -f mke/clusters/rbac/mke-deploy-app-namespaces.yaml
# Role del ns de la BD: `databases-dev` (gamer) o `databases` (laptop).
kubectl --context <ctx> apply -f mke/clusters/rbac/mke-deploy-databases.yaml
```
Nota: `mke` crea el namespace de apps en el preflight (`asegurarNamespace`), un
verbo cluster-scoped que este SA NO tiene. Los ns de apps ya existen, así que no
importa; si algún día nace un ns, lo crea un humano/admin una vez. No le damos
create-namespace al runner a propósito.

## 5. Kubeconfig del runner apuntando al SA (NO admin)
```
SA_TOKEN="$(kubectl --context <ctx> -n mke-ci get secret mke-deploy-token -o jsonpath='{.data.token}' | base64 -d)"
# Construye un kubeconfig con ese bearer token contra el MISMO API server/CA del
# cluster, y apúntalo en el env del runner (KUBECONFIG del servicio systemd
# forgejo-runner). NO borres aún el kubeconfig de admin: guárdalo para revertir.
```

## 6. VERIFICAR con un deploy real ANTES de retirar admin
Con el runner ya usando el kubeconfig del SA:
```
mke deploy <una-app-cualquiera> <env>     # debe pasar entero (preflight→rollout→doctor)
```
El Role de `mke-deploy-app-namespaces.yaml` se derivó leyendo las llamadas
kubectl de mke pero NO se probó en vivo. Si el deploy falla con un
`forbidden: ... cannot <verbo> <recurso>`, AGREGA ese verbo/recurso al Role,
`kubectl apply` de nuevo (efecto inmediato) y reintenta. Repite hasta verde.
Emisión de token de app (lee `iam-operador` vía el Role dedicado) y provisión de
BD (exec en `databases*`) entran en este mismo deploy de prueba.

## 7. Retirar lo viejo (recién ahora)
- Confirma que `iam-mishi-secrets` tiene `IAM_OPERADOR_TOKEN` con el VALOR inerte
  (paso 3), no el claro real. La defensa durable es la rotación a inerte en el
  vault (paso 1), no un `kubectl patch` (que reaparece al próximo deploy).
- Retira/expira el kubeconfig de cluster-admin del runner.
- Repite TODO en el otro cluster.

## Revertir (si algo se rompe en 3–7)
- Runner: vuelve a apuntar KUBECONFIG al admin guardado (paso 5) → deploys como antes.
- Operador: restaura el claro en el ns que el CLI/pod-viejo lea y revert del deploy
  de iam-mishi a la imagen previa. Con el vault append-only, "restaurar" = volver a
  `set` el valor real (por STDIN):
  `printf %s "$OP" | vault-mishi set iam-mishi/IAM_OPERADOR_TOKEN__<env>`
  (y, si ya cortaste el CLI a iam-operador, el claro real ya vive en
  `iam-operador/IAM_OPERADOR_TOKEN__<env>`).
- El hash y el ns `iam-operador` son inertes si no se usan; no hace falta borrarlos.

## Rotación futura del operador
Rota AMBOS a la vez (todo `set` por STDIN; el vault es append-only, se sobreescribe):
```
printf %s "$NUEVO"                         | vault-mishi set iam-operador/IAM_OPERADOR_TOKEN__<env>
printf %s "$(printf %s "$NUEVO"|sha256sum|cut -d' ' -f1)" | vault-mishi set iam-mishi/IAM_OPERADOR_TOKEN_SHA256__<env>
```
Recrea el Secret `iam-operador/iam-operador`; `mke deploy iam-mishi <env>`; revoca la
credencial vieja por CLI. El bootstrap siembra por hash y es idempotente (solo agrega).
