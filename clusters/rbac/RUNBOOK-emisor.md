# RUNBOOK — corte a EMISOR (sacar el operador del cluster) · en vivo

Sucesor de `RUNBOOK-hallazgo0.md`. Ese runbook sacó el token de operador en
CLARO del namespace de las apps a un ns de plataforma (`iam-operador`) que el
runner leía. Residual: **el runner seguía portando el OPERADOR** (super-poder que
puede otorgar `ecosistema/admin`). Este corte lo cierra: el runner pasa a portar
un **EMISOR** de mínimo privilegio (capacidad ÚNICA: acuñar tokens tipo `app`) y
el operador **sale del cluster por completo** (vive solo en el vault + el CLI
humano). Robar lo que el runner toca ya nunca escala a admin del ecosistema.

Lo hace **Santi** (no CI). Toca secrets reales y RBAC. Orden EXACTO: sembrar el
emisor en su nueva casa → apuntar el pod a su hash → RBAC del runner al emisor →
verificar un deploy real → recién ahí RETIRAR el operador del cluster. Cada paso
dice qué rompe si se saltea.

Contexto: `mke-gamer` (stage) y `mke-laptop` (prod) son clusters SEPARADOS. Haz
TODO en uno, verifícalo, y repite en el otro. Manifiestos referidos:
`iam-mishi/k8s/platform/emisor-*.yaml` y `mke/clusters/rbac/emisor-access.yaml`.

## 0. Antes de tocar nada
- Genera el token de emisor (opaco, largo): `EMISOR="iam_emisor_$(openssl rand -hex 32)"`.
- Calcula su hash: `printf %s "$EMISOR" | sha256sum` → 64 hex.
- Confirma que el operador vigente sigue vivo: `IAM_ENV=<env> iam-mishi ls` funciona.
  (No lo vas a mover hasta el paso 5; el emisor se suma en paralelo.)

## 1. Guardar el emisor en el vault (claro + hash separados)
El pod de iam-mishi materializa TODO el ns `iam-mishi` al Secret de apps, así que
allí va SOLO el HASH; el CLARO vive en un ns de vault propio (`iam-emisor`), fuera
del alcance de los pipelines de app:

Todos los `set` toman el valor por **STDIN** (la firma real de `vault-mishi set`):

```
printf %s "$EMISOR" | vault-mishi set iam-emisor/IAM_EMISOR_TOKEN__<env>
printf %s "$HASH"   | vault-mishi set iam-mishi/IAM_EMISOR_TOKEN_SHA256__<env>
```
Invariante que NO se puede violar: `sha256(IAM_EMISOR_TOKEN)` == el
`IAM_EMISOR_TOKEN_SHA256` del ns iam-mishi. Si difieren, tras el paso 3 iam-mishi
siembra una credencial de emisor cuyo hash nadie porta → `mke deploy` no podrá
emitir tokens de app (401 en /v1/credenciales).

## 2. Crear el namespace + Secret del emisor (fuera del ns de apps)
```
kubectl --context <ctx> apply -f iam-mishi/k8s/platform/emisor-namespace.yaml
TOKEN="$(vault-mishi get iam-emisor/IAM_EMISOR_TOKEN__<env>)"
kubectl --context <ctx> -n iam-emisor create secret generic iam-emisor \
  --from-literal=IAM_EMISOR_TOKEN="$TOKEN"
```

## 3. Redeploy de iam-mishi con el hash del emisor (el pod siembra la credencial)
La rama `iam-manifiesto` trae el código (bootstrap siembra emisor por hash) y el
manifiesto (`IAM_EMISOR_TOKEN_SHA256`). Con ella en main:
```
mke deploy iam-mishi <env>
```
Verifica: el pod arranca y loguea `credencial de emisor sembrada desde
IAM_EMISOR_TOKEN_SHA256`. `IAM_ENV=<env> iam-mishi ls` (operador) sigue vivo.

## 4. RBAC del runner: darle el emisor, sin tocar aún el operador
```
kubectl --context <ctx> apply -f mke/clusters/rbac/emisor-access.yaml
```
Efecto: el SA `mke-deploy` (ns `mke-ci`) puede `get` el Secret `iam-emisor`.
Todavía conserva el Role del operador — lo retiramos en el paso 6, después de
verificar. (El SA y los Roles de apps/BD ya están del RUNBOOK-hallazgo0.)

## 5. VERIFICAR con un deploy real ANTES de retirar el operador
`tokenIam.ts` ya lee el EMISOR (`iam-emisor/iam-emisor`), no el operador. Con el
código nuevo del runner desplegado:
```
mke deploy <una-app-que-consuma-iam> <env>   # debe pasar entero (preflight→rollout→doctor)
```
En los logs: `emitiendo token de app para <app>…` → `token IAM … materializado`.
Si falla al LEER el emisor (`no leí la credencial de emisor …`): revisa el paso 4
(RBAC) y el paso 2 (Secret existe). Si falla en /v1/credenciales con 401: el hash
del paso 1 no casa con el claro del paso 2. Si da 403 `fuera_de_ambito`: el token
que porta el runner NO es de tipo emisor (revisa qué sembraste). Arréglalo y
reintenta hasta verde. NO avances con el deploy fallando.

## 6. RETIRAR el operador del cluster (recién ahora)
El runner ya no necesita el operador. Sácalo por completo:
```
# quita el acceso del runner al operador
kubectl --context <ctx> -n iam-operador delete rolebinding mke-deploy-operador-lector
kubectl --context <ctx> -n iam-operador delete role       mke-deploy-operador-lector
# retira el Secret del operador del cluster (su claro vive solo en el vault)
kubectl --context <ctx> -n iam-operador delete secret iam-operador
kubectl --context <ctx> delete namespace iam-operador     # opcional: ns vacío
```
Confirma: `kubectl --context <ctx> get ns iam-operador` no existe (o vacío) y
`mke deploy <app> <env>` sigue verde (usa el emisor). El super-poder ya no vive
en ningún Secret del cluster: solo en `vault iam-operador/IAM_OPERADOR_TOKEN__<env>`
y en el CLI humano. Repite TODO en el otro cluster.

## Revertir (si algo se rompe en 3–6)
- Antes del paso 6: el operador sigue intacto; revierte el código del runner
  (rama previa de mke) y vuelve a `operador-access.yaml` → deploys como antes.
- Después del paso 6: recrea el Secret del operador desde el vault
  (`kubectl -n iam-operador create secret generic iam-operador --from-literal=IAM_OPERADOR_TOKEN=$(vault-mishi get iam-operador/IAM_OPERADOR_TOKEN__<env>)`),
  reaplica `operador-access.yaml` y revierte el código del runner.
- El emisor es inerte si no se usa; no hace falta borrarlo para revertir.

## Rotación futura del emisor
Rota AMBOS a la vez (todo `set` por STDIN; el vault es append-only, se sobreescribe):
```
printf %s "$NUEVO"                         | vault-mishi set iam-emisor/IAM_EMISOR_TOKEN__<env>
printf %s "$(printf %s "$NUEVO"|sha256sum|cut -d' ' -f1)" | vault-mishi set iam-mishi/IAM_EMISOR_TOKEN_SHA256__<env>
```
Recrea el Secret `iam-emisor/iam-emisor`; `mke deploy iam-mishi <env>`; revoca la
credencial de emisor vieja por CLI (`iam-mishi` con operador → `DELETE
/v1/credenciales/:id`). El bootstrap siembra por hash y es idempotente (solo agrega).
