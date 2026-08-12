# AI_PREVIEW_V2 — preview con imagen real (`--v2`)

> 2026-08-12: `--v2` soporta el ESTÁNDAR NUEVO de datos (AI_GRADUACION.md).
> Detección automática (migraciones con RLS) → el pod gana un sidecar
> PostgREST en miniatura: initdb del sidecar postgres crea los roles
> `<db>_web`/`<db>_pgrst` (los guards de las migraciones los esperan), ruta
> `/datos` del host preview vía un SEGUNDO Ingress anotado con los middlewares
> `pgrst-puerta`/`pgrst-strip-datos` del ns preview (fixtures; la ForwardAuth
> apunta a la puerta de stage), y tras cada MIGRATE_ONLY se recarga el schema
> cache con `NOTIFY pgrst` (si no, PGRST202). E2E verde con block-mishi:
> yo/guardar_partida/ranking contra la BD efímera. Bache corregido de paso:
> la readiness del backend ahora pega a `/salud` (estándar 2026-08-09), no a
> `/health` (block no lo servía en raíz y el rollout nunca convergía).

> Diseño, 2026-08-11. Opt-in (`mke preview up <app> <rama> --v2`); NO reemplaza
> v1. Estado de lo construido: `AI_REPO_STATE.md`.

## E2E real (2026-08-11, dropshipping-mishi, cluster mke-gamer ns preview)

| camino | tiempo medido | qué hizo |
|---|---|---|
| `up --v2` (primera vez, imagen ya en caché de docker) | 40.3s | worktree+push, lease, docker build (24.2s, capas cacheadas), push al registry local, apply del pod, rollout, MIGRATE_ONLY, turbo build front (1.6s, caché tibia) + cp |
| `push --v2` carril front (cambio en `apps/frontend`) | 11.4s | turbo build (contract+frontend, caché fría por el cambio) + kubectl cp + version.json |
| `push --v2` carril back (cambio en `apps/backend`) | 32.7s | docker build (25s, capas de deps cacheadas) + push al registry + set image + rollout + MIGRATE_ONLY |

Verificado por curl: `/` 200, `/api/iam/yo` 200 `{"authenticated":false}` (fake
IAM del molde respondiendo, sin sesión), `/salud` 200 `{"ok":true,"dependencias":
{"db":"ok"}}`, `/version.json` pasó de `29f00a1` → `52a4d0c` (front) →
`d1a79c4` (back) seleccionos con el sha de cada commit, sin acción del navegador
más que el poll del actualizador. `mke preview down --forzar` limpió lease +
bundle k8s + CNAME + worktree + ramas local/remota — mismo código de v1,
sin cambios.

Tres bugs reales encontrados y corregidos EN el E2E (no en el diseño de
escritorio) — documentados en el historial de commits de `previewV2.ts`:
1. `esperarConLogs` siguiendo el contenedor `backend` (vida larga) colgaba
   `up --v2` para siempre — a diferencia del `initContainer preparar` de v1,
   que termina solo y cierra el stream de `kubectl logs -f`.
2. El readinessProbe del contenedor `front` pegaba a `/` con `/srv/front`
   vacío (el primer `cp` corre DESPUÉS del rollout) → 404 → el pod nunca
   convergía. Ruta interna `/_mke/listo` que Caddy responde 200 sin tocar el
   volumen.
3. El carril front necesita `npm ci` (worktree pelado, sin `node_modules`) y
   `turbo run build --filter=./apps/frontend` en vez de `npm run build -w
   apps/frontend` a secas — el frontend importa `@<app>/contract` y ese
   workspace necesita SU build primero (mismo grafo que ya usa el Dockerfile
   real). El caché de turbo vive en `tmpdir()`, no en el repo (un
   `--cache-dir` relativo ensuciaba el worktree con archivos sin trackear).
4. `kubectl cp` (a diferencia de `kubectl exec`) NO acepta `deploy/<nombre>`
   como destino — hace falta resolver el pod real por selector primero.

## El problema

`mke preview up` (v1) clona el repo y corre `tsx watch`/`vite` DENTRO del pod:
cold start de minutos (clone+install) y ejecuta código DISTINTO al de stage
(dev mode, no el Dockerfile real). El "actualizador silencioso" del molde
(`/version.json` + poll) ya resuelve "aplicar un cambio sin que el humano
haga nada" sin necesitar HMR — así que un preview puede ser **imagen real +
canal de updates** en vez de un dev-server persistente.

## Norte: `artifact = preview sin backend; preview = artifact + backend + DB + rama`

Ambos verbos publican archivos estáticos a un volumen y avisan al navegador.
`volumenEstatico.ts` (nuevo, compartido) es el motor de esa pieza:

```ts
copiarArbolAPod(ctx, ns, pod, contenedor, origenLocal, destinoEnPod)
escribirVersionJson(ctx, ns, pod, contenedor, destinoEnPod, version)
```

`mke preview push --v2` (carril front) lo usa directo. `artifact.ts`
(`sincronizarRuntime`/el `kubectl cp` de `artifactPublicar`) hace HOY lo mismo
a mano con su propio `execEnPod`/`run kubectl cp` — **no se tocó** en esta
tanda para no arriesgar el camino ya probado en producción (artifacts es
plataforma viva); queda propuesto como el próximo paso de unificación una vez
`--v2` esté probado: migrar `artifact.ts` a `volumenEstatico.ts` sin cambiar
su comportamiento (mismo `kubectl cp` + mismo hash-skip), y de ahí sale UN solo
dueño para "publicar estático a un volumen de plataforma".

## Los dos carriles

**Carril front (frecuente, ~5-10 s):** `vite build` LOCAL (en el worktree) →
`copiarArbolAPod` del `dist/` al `emptyDir` que monta el contenedor `front`
(caddy) → `escribirVersionJson`. Sin Docker: el mismo build que corre en CI,
corrido a mano, servido por el mismo caddy que ya usa v1 (`file_server` +
`try_files` SPA en vez de `reverse_proxy` a vite).

**Carril back (raro, ~30-60 s):** `docker build` del backend (mismo Dockerfile
real, mismos flags que `mke deploy` — `--provenance=false --sbom=false` +
BuildKit secret `node_auth_token`, caché de capas de BuildKit: si no cambió
`package*.json` el `npm ci` no se repite) → `cargarImagenes` al registry local
del nodo (`k3d-registry-mishi:5111`, mismo camino que usa `mke deploy`; sin
declaración cae a `k3d image import`, igual retrocompat) → `kubectl set image`
+ `rollout status` del contenedor `backend` del Deployment del preview.

`mke preview push <app> <rama> --v2` detecta QUÉ carril correr con
`git diff --name-only` en el worktree contra el último push registrado
(annotation `mke.preview/sha` del Deployment, el mismo campo que v1 ya
declaraba sin usar): toca `apps/frontend|packages/contract` → carril front;
toca `apps/backend|Dockerfile|package.json|package-lock.json` → carril back;
ninguno → no-op; ambos → corre los dos y mide cada uno por separado.

## Forma del pod v2

Mismo namespace `preview`, mismo host `<app>-<rama-slug>.mishi.com.co`, mismos
labels `mke.preview/*` (reusa `previewPodName/Host/selectorDePreview` de
`@mishicomco/dev-receta` — CERO nombres nuevos que inventar). Reemplaza SOLO
el `initContainer preparar` + contenedor `dev` (clone+install+tsx watch) por:

- **sidecar `postgres`** — IDÉNTICO a v1 (imagen, env, `emptyDir`, readiness).
  DB efímera, muere con el pod, cero PVC.
- **contenedor `backend`** — la imagen REAL (`<app>:<sha>`, la que `mke deploy`
  construye), sin comando propio (ENTRYPOINT/CMD del Dockerfile). Env: la
  MISMA receta que v1 (`APP`, `RAMA`, `PREVIEW`, `PREVIEW_MODE`,
  `RAMA_ENCENDIDA=true`, `DATABASE_URL` al sidecar loopback, `config:` del
  manifiesto, `LEASE_TOKEN` del Secret del lease) — el backend del molde lee
  `RAMA_ENCENDIDA` en RUNTIME (`ramaEncendida.ts`: `process.env.RAMA_ENCENDIDA
  === 'true'`, evaluado en cada llamada, no en build) y el fake IAM
  (`iamMishi.ts`) hace lo mismo — **viajar por env del Deployment, no del
  build, es exactamente lo que la imagen real ya espera**; verificado leyendo
  el molde, no supuesto.
- **contenedor `front`** — SOLO si `forma.frontend`: `caddy:2-alpine` sirviendo
  un `emptyDir` (`/srv/front`) con `file_server` + `try_files {path} /index.html`
  (SPA) y `reverse_proxy /api/*|/salud|/health* → 127.0.0.1:3000` (mismo
  puerto `DEV_BACKEND_PORT` que v1 — la app del molde escucha ahí por default).
  Backend-only: el Service apunta directo al `backend` (sin `front`), como v1.
- Sin `initContainer preparar`, sin volumen `workspace`, sin ConfigMap de
  scripts de dev — el pod nace CON el contenido (imagen + `dist/` copiado tras
  el primer `up`), no lo construye en vivo.

## Migraciones dentro del pod v2

La imagen de producción no trae `npm`/`drizzle-kit` en dev mode, pero SÍ trae
el modo `MIGRATE_ONLY=true` que usa el Job de `mke deploy`
(`compuertaMigraciones.ts`) — el mismo proceso Node, mismo `dist/index.js`,
lee `runMigrations()` y sale. `up --v2` lo dispara con:

```
kubectl exec deploy/<name> -c backend -- sh -c "cd /app && MIGRATE_ONLY=true node dist/index.js"
```

Comparte pod (mismo namespace de red) con el sidecar `postgres`, así que
`DATABASE_URL=postgres://dev:dev@127.0.0.1:5432/dev` (el mismo loopback que ya
usa v1) migra contra el sidecar sin tocar nada externo. `db:sembrar`/`--espejo`
de v1 no aplican tal cual (no hay `npm run` en la imagen de prod): sembrado por
ahora es responsabilidad de la propia app (migraciones con seed data) o
`--espejo` de v1 — **anotado, no resuelto**: portar `--espejo` a v2 exige un
modo `SEED_ONLY` análogo a `MIGRATE_ONLY` en el molde (decisión de contrato de
plataforma, no la tomo acá — ver "Decisiones escaladas").

## Qué se REUSA sin cambios (mismo código, cero duplicado)

`preview.ts` exporta ahora (antes privados, sin cambiar su cuerpo):
`worktreeDir`, `asegurarWorktree`, `borrarWorktreeSiExiste`, `resolveRepoUrl`
(v2 no clona, pero SÍ empuja la rama a origin igual que v1 — mismo flujo git),
`resolveNpmToken`, `resolveEmisorTokenSuave`, `vaultCliente`, `adquirirLease`,
`leaseIdDe`, `limpiarCluster`, `commitsSinMergear`, `waitReachable`,
`diagnosticarPodNoListo`. `previewV2.ts` los importa: lease del vault (Contrato
1), lectura de `mke.preview.yaml` (Contrato 2), DNS, `down`/`merge` (SIN
cambios: bajan cualquier bundle por labels `mke.preview/*`, v1 o v2, igual).
`cargarImagenes`/`describeCarga` de `cargaImagenes.ts` (mismos que `mke
deploy`) para el carril back. `doctor.ts` para el postflight.

## Decisiones tomadas (y por qué)

- **Caddy, no nginx, para el sidecar front**: v1 ya usa `caddy:2-alpine` como
  único-origen; reusar la imagen evita un tercer sabor de proxy en la flota y
  el operador ya conoce sus logs/gotchas.
- **`emptyDir` para el `dist/` del front, no un PVC**: el preview es efímero
  por diseño (muere con la rama); un PVC sobrevive al pod y complica la
  limpieza — mismo criterio que la DB sidecar.
- **Mismo nombre/host que v1 para la misma app×rama**: `--v2` reemplaza el
  bundle v1 si corrés `up --v2` sobre una rama que ya tenía v1 (mismos labels,
  mismo `down`/`merge` los borra a ambos). Asumido: nadie corre v1 y v2 A LA
  VEZ para la misma rama. Si eso importa, la señal es "converger del todo a
  v2" — decisión de Santi, no la fuerzo con un sufijo de host nuevo.

## Decisiones escaladas (el brief no las cubre)

1. **`--espejo`/`db:sembrar` en v2**: portarlo exige un modo `SEED_ONLY`
   horneado en el molde (análogo a `MIGRATE_ONLY`), porque la imagen de prod no
   trae `npm run db:sembrar`. Opciones: (a) hornear `SEED_ONLY` en
   `create-mishi-app` ahora, (b) dejar v2 SIN siembra por ahora (solo
   migraciones vacías) y que cada app semille en su propia migración/arranque,
   (c) mantener v1 como el camino con `--espejo` y que v2 solo sirva para
   iterar código con datos que la propia app siembra al migrar. Recomiendo
   (c) para no tocar el molde de todas las apps sin que Santi lo pida.
2. **Convergencia v1→v2 (matar v1)**: falta medir v2 en más apps (solo probado
   con dropshipping-mishi acá) y decidir el `SEED_ONLY` de arriba antes de
   proponer apagar v1.
