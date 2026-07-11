# AI_REPO_STATE — mke

> Regla: estado, no bitácora. Qué es verdad HOY. La historia vive en git.

## Qué es

MKE (Mishi Kubernetes Engine) = la plataforma que sirve `*.mishi.com.co`. Un mismo sabor de k8s (k3d/k3s) replicado por overlays Kustomize, cambiando solo configuración, nunca código. Repo de la plataforma (clusters, componentes base in-cluster, scripts); las apps viven en sus propios repos.

## Estado actual

- **Cluster único `k3d-mke-prod`** en el PC gamer (`SantiGamer`, WSL2): stage y prod son **namespaces** (`stage` / `prod`) del mismo cluster, no clusters separados. `mke-stage` como cluster fue eliminado.
- **`mke-local`**: k3d en el laptop (WSL2) para dev. Wildcard `*.mishi.com.co → mke-local`.
- **`mke-cloud`**: futuro (GKE + prod-mke como fallback); sin desplegar.
- **`mke dev` (2026-07-06, en main) — DEPRECADO por `mke preview`** (imprime warning apuntando a preview; se conserva por músculo-memoria/skills). Pod DURADERO por app en ns `dev` de mke-preview (init clona rama + install, vite HMR + tsx watch, caddy un-solo-origen, postgres efímero; host `<app>-dev-feat`). Verbos `up/rama/pull/estado/ls/down`; `--env K=V`, `--live`, NODE_AUTH_TOKEN opcional. Receta pura en `packages/dev-receta`; estado en labels/annotations `mke.dev/*`. **Contrato `k8s/dev.env`** + **CANDADO `cargar-dev-env.sh`** (aborta si declara `VITE_*TOKEN*`). `mke rama` = FACHADA deprecada que delega a `mke dev`.
- **CLI `mke`** es la interfaz canónica (deploy/rollout/expose/dns/doctor/ls/**app init**/**rama up|down|ls**). No hacer kubectl/docker/cloudflared a mano salvo fallback. Ver skill `mke-deploy`.
- **`mke app init <app>` (2026-07-03, en main; rama `feat/static-host` NO mergeada agrega el paso 5):** nacimiento de plataforma en un comando, idempotente — BD+rol en postgres-mishi (con fix de owner), `mishi-secret set mke/<app>/<env>/database-url`, Secret k8s (`<app>-secrets` con DATABASE_URL+SESSION_SECRET), DNS dash-form, **host del front en el ingress de static-mishi (paso 5, SIEMPRE stage+prod)**; `--env stage|prod`, `--subdominio`, `--dry-run`. Lo invoca `mishi-studio app nacer` como paso plataforma.
- **Host de static-mishi ya NO es manual (rama `feat/static-host`, `cli/src/staticHost.ts`, NO mergeada):** cerraba el único eslabón manual del nacimiento — nadie agregaba el host del front nuevo al ingress compartido (404 hasta editar a mano). El paso edita `static-mishi/k8s/overlays/{stage,prod}/ingress.yaml` clonando el bloque de regla existente (mismo shape para apps con/sin backend — su `/api` va en el ingress propio del backend), hace commit+push directo a main de static-mishi (aprobado por Santi, es config de plataforma) y deja que el CI de static-mishi aplique el overlay (no se toca el cluster a mano). Idempotente por host; verbo suelto `mke static agregar <sub>` para correrlo aparte del nacimiento completo.
- **Cluster separado `k3d-mke-preview`** (mismo PC gamer): previews EFÍMEROS por app×feature para que Mishi Studio spawnee tantos pods como quiera sin tocar `mke-prod`. Trae su propio túnel cloudflared (`mke-preview`, bootstrap en `scripts/bootstrap-preview.sh`) y Traefik; sin postgres propio — cada preview trae su postgres efímero (`postgres:16-alpine`, `emptyDir`, sin PVC).
- **`mke preview up|pull|estado|ls|merge|down|limpiar`** (VERBO DEFINITIVO, 2026-07-11, rama `feat/pod-preview-v2`, NO mergeado) — FUSIÓN de `feat/mke-preview` + WIP `feature-pods-cli` (respaldo en rama `rescate/feature-pods-cli`). Preview-pod EFÍMERO atado a la vida de la RAMA: anatomía de `mke dev` (`manifiestosPreview` en `packages/dev-receta`), ns `preview`, host BARE `<app>-<rama-slug>.mishi.com.co`. **DB = SIDECAR postgres efímero** (`emptyDir`, `DATABASE_URL` loopback `127.0.0.1`): muere con el pod, sin DROP central; el boot corre `db:migrate` idempotente (auto-sana el schema). `up`: crea la rama local si falta (desde main) + git worktree `<app>.wt-<rama-slug>` + push; **LEASE del vault** (`POST /v1/lease {ns,rama,secretos,ttlSegundos}` — token en Secret `<name>-lease` + env `LEASE_TOKEN`, TODO el bundle con labels `mke.preview/app|rama|lease`) leyendo la sección `secretos:` de `mke.preview.yaml` del WORKTREE (Contrato 2; `config:` → env en claro; CERO `--env`; token emisor `mishi-secret get vault-mishi-emisor-token`); migra + siembra (`db:sembrar`, PREVIEW_MODE=true) o `--espejo` (TRUNCATE + `pg_dump --data-only` de stage excluyendo `apps/backend/db/tablas-sensibles.txt`, restaurado DENTRO del sidecar). **DEGRADACIÓN interina**: el escenario 4 del vault NO está desplegado → si el vault no responde/falta el emisor, `up` arranca SIN lease (`leaseId=sin-lease`, warning) para probar pod+DB+HMR en vivo; NODE_AUTH_TOKEN sigue de `mishi-gh-read-packages-pat`. **`merge <app> <rama>`** = ÚNICO final feliz: worktree limpio → merge a main + push → borra worktree + rama local + rama REMOTA (dispara el `on: delete` → limpieza cluster; no espera). **`down <app> <rama>`** a mano = ABORTO TOTAL (revoca lease + borra bundle por labels + CNAME + worktree + rama local+remota; GUARDARRAÍL: se niega si hay commits sin mergear salvo `--forzar`); `--sin-worktree`/sin-worktree = MODO RUNNER (solo cluster, sin tocar ramas — lo usa el `on: delete`). `limpiar` = red de seguridad (modo runner). Guardarraíl DNS (`cf.ts`) permite el host BARE exacto. Módulos: `preview.ts`, `previewEspejo.ts`, `previewManifest.ts` (`mke.preview.yaml`), `vaultLease.ts`; `VAULT` en `mkeConfig.ts`.
- Ingress: Traefik en ns `ingress`. Entrada pública vía cloudflared in-cluster (túnel `mke-prod`).
- Apps desplegadas de referencia: `hello-mishi` (stateless) y `mesh-central` (MeshCentral, stateful, PVCs). Las apps reales del ecosistema (omni, bank, polla, travelhabit) despliegan por su propio CI/CD hacia este cluster.

## Convenciones

- Subdominios: no-prod con guion (`<app>-local`, `<app>-stage`), prod pelado (`<app>`). Detalle y footguns en `AI_ARCHITECTURE.md`.
- Overlays Kustomize por entorno: `local` / `stage` / `prod` (+ `cloud` futuro).
- Un nodo → resiliencia por backups off-site, no HA en caliente.

## Verificación rápida

```bash
mke doctor
mke ls
ssh mke-home 'bash -lc "k3d cluster list; kubectl config get-contexts"'
curl -sS -o /dev/null -w "%{http_code}\n" https://hello.mishi.com.co
```

## Decisiones y diseño

- **`AI_ARCHITECTURE.md`** — cadena de red Cloudflare→cloudflared→Traefik, convención de subdominios, gotchas DNS/túnel, checklist de apps detrás del reverse proxy (TLS-offload, X-Forwarded-Proto, `@kubernetescrd`), SSH remoto.
- **MeshCentral admins/credenciales** — gestionados por la skill `mesh-central-admin` (passwords en GPG, nunca en repo).
- **Deploy** — skill `mke-deploy`.
- Meta CI/CD del ecosistema: loop cerrado con runner self-hosted (build local → k3d import → apply); ver `../CLAUDE.md`.
