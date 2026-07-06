# AI_REPO_STATE — mke

> Regla: estado, no bitácora. Qué es verdad HOY. La historia vive en git.

## Qué es

MKE (Mishi Kubernetes Engine) = la plataforma que sirve `*.mishi.com.co`. Un mismo sabor de k8s (k3d/k3s) replicado por overlays Kustomize, cambiando solo configuración, nunca código. Repo de la plataforma (clusters, componentes base in-cluster, scripts); las apps viven en sus propios repos.

## Estado actual

- **Cluster único `k3d-mke-prod`** en el PC gamer (`SantiGamer`, WSL2): stage y prod son **namespaces** (`stage` / `prod`) del mismo cluster, no clusters separados. `mke-stage` como cluster fue eliminado.
- **`mke-local`**: k3d en el laptop (WSL2) para dev. Wildcard `*.mishi.com.co → mke-local`.
- **`mke-cloud`**: futuro (GKE + prod-mke como fallback); sin desplegar.
- **`mke rama up/down/ls` (2026-07-04, harness v2)**: el "pod de rama" de Mishi Studio — ns `ramas` en mke-preview; init clona ref de GitHub + install + build, caddy sirve el front estático + proxy /api al backend (un solo origen), sidecar postgres efímero, host `<app>-<rama>-feat.mishi.com.co` (CNAME Cloudflare; `--sin-dns` para pruebas, `--dry-run`, `--json` para Studio). Imagen `images/rama-runner`. La RECETA vive en el paquete `packages/rama-receta` (@mishicomco/rama-receta, fuente única; el CLI es un cliente — Studio la consume vendorizada hasta publicarla a GitHub Packages). PENDIENTE: secreto `github-rama-token` (PAT read-only) para clonar repos privados + prueba viva end-to-end.
- **`mke dev` (2026-07-06, en main)**: SERVIDOR DE ITERACIÓN — pod DURADERO por app en ns `dev` de mke-preview (init clona rama + install, contenedor dev corre vite HMR + tsx watch, caddy un-solo-origen, postgres efímero; host `<app>-dev-feat`). Verbos `up/rama/pull/estado/ls/down`; `--env K=V` (Secret + envFrom; re-aplicar SIN --env los borra, y cambiar solo el env NO recicla el pod — rollout restart a mano), `--live` (vite bajo `/live/<app>/` + annotation `mke.dev/live` → Studio lo embebe same-origen), NODE_AUTH_TOKEN opcional (Secret `<name>-npm`, GitHub Packages privados, `mishi-secret get mishi-gh-read-packages-pat`). Receta pura en `packages/dev-receta`; estado en labels/annotations k8s (`mke.dev/*`) — Studio DERIVA de ahí.
- **CLI `mke`** es la interfaz canónica (deploy/rollout/expose/dns/doctor/ls/**app init**/**rama up|down|ls**). No hacer kubectl/docker/cloudflared a mano salvo fallback. Ver skill `mke-deploy`.
- **`mke app init <app>` (2026-07-03, en main):** nacimiento de plataforma en un comando, idempotente — BD+rol en postgres-mishi (con fix de owner), `mishi-secret set mke/<app>/<env>/database-url`, Secret k8s (`<app>-secrets` con DATABASE_URL+SESSION_SECRET), DNS dash-form; `--env stage|prod`, `--subdominio`, `--dry-run`. Lo invoca `mishi-studio app nacer` como paso plataforma.
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
