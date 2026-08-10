# RUNBOOK — cerrar el Hallazgo 0 (operador robable) · corte en vivo

Lo hace **Santi** (no CI). Toca secrets reales y RBAC del cluster. Orden EXACTO:
crear el operador en su nueva casa → apuntar el pod al hash → RBAC del runner →
verificar → recién ahí retirar lo viejo. Cada paso dice qué rompe si se saltea.

Contexto: `mke-gamer` (stage) y `mke-laptop` (prod) son clusters SEPARADOS. Haz
TODO en uno, verifícalo, y repite en el otro. Los manifiestos referidos:
`iam-mishi/k8s/platform/*` y `mke/clusters/rbac/*`.

## 0. Antes de tocar nada
- Ten a mano el token de operador vigente: `vault-mishi get iam-mishi/IAM_OPERADOR_TOKEN__<env>`.
- Calcula su hash: `printf %s "<token>" | sha256sum` → 64 hex. Verifica que es el
  MISMO token con el que hoy opera el CLI (`IAM_ENV=<env> iam-mishi ls` funciona).

## 1. Mover el token de operador al vault-ns dedicado
Para no romper la materialización de `iam-mishi` (mke materializa TODO el ns
`iam-mishi` al Secret de apps), el CLARO se muda a un ns de vault propio y en
`iam-mishi` queda solo el HASH:

```
vault-mishi set iam-operador/IAM_OPERADOR_TOKEN__<env>        <token-claro>
vault-mishi set iam-mishi/IAM_OPERADOR_TOKEN_SHA256__<env>    <hash-64hex>
vault-mishi rm  iam-mishi/IAM_OPERADOR_TOKEN__<env>           # que deje de materializarse al ns de apps
```
Si te salteas el `rm`: el token en claro seguirá aterrizando en `iam-mishi-secrets`
del ns de apps en el próximo deploy — el Hallazgo 0 NO se cierra.

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
Verifica: el pod arranca, `kubectl -n <apps-ns> get secret iam-mishi-secrets -o jsonpath='{.data}'`
ya NO trae `IAM_OPERADOR_TOKEN` (solo `DATABASE_URL` + `IAM_OPERADOR_TOKEN_SHA256`).
`IAM_ENV=<env> iam-mishi ls` sigue funcionando (el hash sembrado casa con el claro del vault).
Si te salteas el paso 1 (`rm`), aquí reaparece el claro en el Secret de apps.

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
- Confirma que NINGÚN Secret del ns de apps tiene ya `IAM_OPERADOR_TOKEN`.
- Retira/expira el kubeconfig de cluster-admin del runner.
- Repite TODO en el otro cluster.

## Revertir (si algo se rompe en 3–7)
- Runner: vuelve a apuntar KUBECONFIG al admin guardado (paso 5) → deploys como antes.
- Operador: `vault-mishi set iam-mishi/IAM_OPERADOR_TOKEN__<env> <token>` y revert
  del deploy de iam-mishi a la imagen previa → vuelve a leer el claro del Secret.
- El hash y el ns `iam-operador` son inertes si no se usan; no hace falta borrarlos.

## Rotación futura del operador
Rota AMBOS a la vez: nuevo token → `iam-operador/IAM_OPERADOR_TOKEN__<env>` +
su hash → `iam-mishi/IAM_OPERADOR_TOKEN_SHA256__<env>`; recrea el Secret
`iam-operador/iam-operador`; `mke deploy iam-mishi <env>`; revoca la credencial
vieja por CLI. El bootstrap siembra por hash y es idempotente (solo agrega).
