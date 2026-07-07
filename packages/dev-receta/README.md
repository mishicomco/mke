# `@mishicomco/dev-receta`

Receta PURA del **pod de ITERACIÓN** (`mke dev`) del harness v2 de Mishi Studio:
`manifiestosDev({app, rama, repoUrl, …})` → array de manifiestos de k8s
(Namespace/Secret/ConfigMap/Deployment/Service/Ingress) + nombres/host + config
de vite del modo dev. Sin efectos: el consumidor (el CLI `mke` y Studio)
serializa y aplica.

Desde la unificación (2026-07-06) es el **ÚNICO mecanismo de rama** del
ecosistema. La vieja `@mishicomco/rama-receta` (pod efímero, front estático) está
DEPRECADA — ver su `DEPRECATED.md`.

## El pod

- pod DURADERO por app en ns `dev` (clúster mke-preview; JAMÁS mke-prod).
- init `preparar`: git clone COMPLETO → checkout de la rama → `npm install` +
  build de los packages del workspace.
- contenedor `dev`: espera postgres → reset DB efímera + migra + siembra →
  backend `tsx watch` + `vite dev` (HMR wss:443), cada uno bajo un supervisor que
  lo reinicia si muere o si cambia la rama.
- contenedor `web` (caddy): un solo origen (host público → vite; /api,/health,/dev
  → backend).
- sidecar `postgres:16-alpine` (emptyDir): DB efímera por loopback.

## Config por rama: `k8s/dev.env` (config PÚBLICA) + `--env` (override)

Una app declara su **config pública NO secreta** por rama en `k8s/dev.env` de su
repo (líneas `K=V`, opcional):

```
# k8s/dev.env — config pública del pod de iteración (NO secretos)
VITE_CONNECT_URL=https://identity-dev.mishi.com.co
VITE_GOOGLE_CLIENT_ID=1234567890-abc.apps.googleusercontent.com
```

El pod la **sourcea al boot y al cambiar de rama** (`cargar-dev-env.sh`), así:

- cada rama trae SU config (cambiar de rama recoge los envs de esa rama);
- re-aplicar `mke dev up` **sin** `--env` ya no pierde nada (la verdad vive en el
  repo, no en un flag efímero).

**Precedencia** (el de mayor rango gana):

```
--env K=V del CLI   >   k8s/dev.env del repo   >   defaults de la receta
```

El `--env` del CLI viaja por un Secret k8s (`<name>-env` + envFrom) y ya está en
el entorno del contenedor; `cargar-dev-env.sh` solo rellena claves que **no**
estén ya presentes, por eso el override y los defaults de la receta (PORT,
PREVIEW, DATABASE_URL, RAMA, NODE_ENV) siempre ganan sobre el archivo. La misma
precedencia está modelada, y testeada, en las funciones puras `parseDotEnv` y
`mergeDevEnv`.

> **PROHIBIDO poner secretos en `k8s/dev.env`** — es config pública que queda en
> el repo y se sirve al cliente (los `VITE_*` se hornean en el bundle). Para
> secretos rige el contrato **RAMA_ENCENDIDA** (efímeros autogenerados por la
> plataforma, inyectados como Secret aparte).
>
> **CANDADO explícito: nunca declares `VITE_STUDIO_TOKEN` (ni ningún
> `VITE_*TOKEN*`) en `k8s/dev.env` de ningún repo.** Un Bearer horneado en el
> bundle del navegador es indefendible — cualquiera con devtools lo lee. La
> cabina del pod de iteración entra por **LOGIN** (identity-preview, cookie
> compartida `mishi_sesion`), no por Bearer; el Bearer server-to-server sigue
> existiendo para agentes/CLI que hablan a la API directamente, pero jamás debe
> viajar al cliente. `cargar-dev-env.sh` detecta `VITE_*TOKEN*` en dev.env y
> **aborta el boot ruidosamente** (no lo carga en silencio, no autotruncar) —
> mismo espíritu de "abortar ruidoso" que el guard `RAMA_ENCENDIDA` del backend.

### Cama tendida: leases de `vault-mishi` (futuro, NO construido)

A futuro los secretos por rama vendrán de **leases de `vault-mishi`**: el pod
pedirá un lease de corta vida (credenciales de DB, tokens de servicio) en vez de
recibir un Secret estático. NO está construido — cuando exista, el punto de
enganche es el mismo `cargar-dev-env.sh` / el Secret `<name>-env`: se añade un
paso que resuelve el lease al boot y exporta las credenciales efímeras, sin tocar
el contrato público de `k8s/dev.env`. No lo construyas antes de que haya una
necesidad real.

## Estado para Studio

Studio DERIVA el estado del pod de las labels/annotations `mke.dev/*` del
Deployment: `mke.dev/app`, `mke.dev/rama` (rama activa), `mke.dev/sha` (sha VIVO
del workspace, escrito por el CLI leyendo `git rev-parse` DENTRO del pod, no del
Deployment) y `mke.dev/live` (modo EMBED). Nunca narres estado del pod fuera de
ahí.
