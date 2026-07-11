# `@mishicomco/dev-receta`

Receta PURA del **preview-pod** (`mke preview`) del harness v2 de Mishi Studio:
`manifiestosPreview({app, rama, repoUrl, leaseId, …})` → array de manifiestos de
k8s (Namespace/Secret/ConfigMap/Deployment/Service/Ingress) + nombres/host +
config de vite del modo dev. Sin efectos: el consumidor (el CLI `mke` y Studio)
serializa y aplica.

Los verbos `mke dev` (pod DURADERO por app) y `mke rama` (fachada de `mke dev`)
fueron BORRADOS (2026-07-11): `mke preview` — rama efímera con worktree + pod
HMR + DB sidecar + lease del vault — es el único camino de iteración. Este
paquete conserva la maquinaria compartida (init clona+instala, vite HMR + tsx
watch, caddy un-solo-origen, config `k8s/dev.env`) que `manifiestosPreview`
sigue reusando.

## El pod

- pod EFÍMERO atado a la vida de la rama, en ns `preview` (clúster mke-preview;
  JAMÁS mke-prod).
- init `preparar`: git clone COMPLETO → checkout de la rama → `npm install` +
  build de los packages del workspace.
- contenedor `dev`: espera postgres → migra (`db:migrate` idempotente; siembra o
  `--espejo` los orquesta el CLI tras el rollout) → backend `tsx watch` +
  `vite dev` (HMR wss:443), cada uno bajo un supervisor que lo reinicia si muere
  o si cambia la rama.
- contenedor `web` (caddy): un solo origen (host público → vite; /api,/health,/dev
  → backend).
- sidecar `postgres:16-alpine` (emptyDir): DB efímera por loopback, muere con el
  pod (sin DROP central).

## Config por rama: `k8s/dev.env` (config PÚBLICA)

Una app declara su **config pública NO secreta** por rama en `k8s/dev.env` de su
repo (líneas `K=V`, opcional):

```
# k8s/dev.env — config pública del preview-pod (NO secretos)
VITE_CONNECT_URL=https://identity-dev.mishi.com.co
VITE_GOOGLE_CLIENT_ID=1234567890-abc.apps.googleusercontent.com
```

El pod la **sourcea al boot y al cambiar de rama** (`cargar-dev-env.sh`), así
cada rama trae SU config. Los secretos y la config no-sensible de `mke preview`
vienen del **lease del vault** (Contrato 1) leyendo `mke.preview.yaml` de la app
(Contrato 2) — `k8s/dev.env` es un complemento opcional del repo, NO el canal de
secretos.

**Precedencia** (el de mayor rango gana):

```
env del Deployment (lease/config del Contrato 2)   >   k8s/dev.env del repo   >   defaults de la receta
```

`cargar-dev-env.sh` solo rellena claves que **no** estén ya presentes en el
entorno, por eso los defaults de la receta (PORT, PREVIEW, DATABASE_URL, RAMA,
NODE_ENV) y la config del Deployment siempre ganan sobre el archivo. La misma
precedencia está modelada, y testeada, en las funciones puras `parseDotEnv` y
`mergeDevEnv`.

> **PROHIBIDO poner secretos en `k8s/dev.env`** — es config pública que queda en
> el repo y se sirve al cliente (los `VITE_*` se hornean en el bundle). Para
> secretos rige el **lease de `vault-mishi`** que `mke preview` resuelve.
>
> **CANDADO explícito: nunca declares `VITE_STUDIO_TOKEN` (ni ningún
> `VITE_*TOKEN*`) en `k8s/dev.env` de ningún repo.** Un Bearer horneado en el
> bundle del navegador es indefendible — cualquiera con devtools lo lee. La
> cabina del pod entra por **LOGIN** (identity-preview, cookie compartida
> `mishi_sesion`), no por Bearer; el Bearer server-to-server sigue existiendo
> para agentes/CLI que hablan a la API directamente, pero jamás debe viajar al
> cliente. `cargar-dev-env.sh` detecta `VITE_*TOKEN*` en dev.env y **aborta el
> boot ruidosamente** (no lo carga en silencio, no autotruncar).

## Estado para Studio

Studio DERIVA el estado del pod de las labels/annotations `mke.preview/*` del
Deployment: `mke.preview/app`, `mke.preview/rama` (slug), `mke.preview/lease`,
`mke.preview/sha` (sha VIVO del workspace, escrito por el CLI leyendo
`git rev-parse` DENTRO del pod, no del Deployment) y `mke.dev/live` (modo
EMBED, nombre heredado del mundo `mke dev`). Nunca narres estado del pod fuera
de ahí.
