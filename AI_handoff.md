# MKE — AI Handoff

## Sesión: Reorganización de repos + decisiones de arquitectura
**Fecha:** 2026-06-19
**Estado:** Arquitectura definida y simplificada. Reorg de repos hecha. **Nada construido aún en pc home** — siguiente sesión arranca ahí.

> La arquitectura completa y duradera está en memoria: `mke-architecture.md`
> (`~/.claude/projects/-home-santi-ProjectsSanti/memory/`). Este handoff es el estado + próximos pasos.

---

## Lo que se hizo esta sesión

### 1. Reorganización de repositorios
- Se sacó `MKE/apps` → ahora es `mishi-apps/` **fuera** de MKE.
- Se agruparon ambos dentro de `./mishicomco/`:
  ```
  ~/ProjectsSanti/mishicomco/
  ├── MKE/                      # repo git (plataforma: clusters/, platform/, scripts/)
  └── mishi-apps/
      └── hello-mishi/          # repo git propio (cada app = su repo)
  ```
- **`MKE` es un repo git** (rama `main`). **Cada app en `mishi-apps/` es su propio repo git.** `mishicomco/` NO es repo.
- El workflow `hello-mishi.yml` se movió de `MKE/.github` al repo de la app, con rutas relativas a la raíz del repo (`context: .`, tags `v*`).
- `scripts/deploy-app.sh` ajustado: las apps se resuelven en `$MKE_ROOT/../mishi-apps/$APP`.

### 2. Convención de entornos y subdominios (DECIDIDO)
Entornos = overlays kustomize. **No-prod lleva segmento; prod va pelado.**

| Overlay | Subdominio (app `hello`) | Cluster |
|---|---|---|
| local | `hello.local.mishi.com.co` | laptop (k3d) |
| stage | `hello.stage.mishi.com.co` | pc home (`mke-stage`) |
| cloud | `hello.mishi.com.co` | producción |

- **id interno** (`hello-mishi`: imagen, recursos k8s, namespace, repo) está desacoplado a propósito del **subdominio** (`hello`).
- ✅ **APLICADO:** overlays de `hello-mishi` corregidos (`local`→`hello.local...`, `cloud`→`hello.mishi.com.co`), overlay `home` renombrado a `stage` (`hello.stage...`, `MKE_TARGET=stage`). Workflow `hello-mishi.yml` (job `deploy-stage`, entorno `stage`) y `MKE/scripts/deploy-app.sh` (`home`→`stage`, contexto `mke-stage`) actualizados. Verificado con `kustomize build` de los 3 overlays.

### 3. Arquitectura simplificada (DECIDIDO — ver memoria para detalle)
- **HA en caliente archivado.** Servir desde un solo lugar (pc home 24/7); resiliencia = backups off-site, no standby. El patrón gratis (Cloudflare Tunnel con 2 connectors) queda guardado por si se retoma; nunca el Load Balancer de pago.
- **Datos:** una instancia Postgres por entorno, **una BD por app** (no schema-por-app), un rol por app, **PgBouncer** al frente. **Redis diferido** (YAGNI).
- **Backups 3-2-1:** `pg_dump` nocturno por BD → copia local pc home + `rclone` a **Google Drive** (gratis, sin tarjeta). R2 opcional luego. PITR (pgBackRest/wal-g) diferido.
- **Stateful** (mesh-central, etc.): una sola casa + backup/restore. Longhorn diferido hasta multi-nodo.
- **Seguridad:** Sealed Secrets/SOPS para credenciales en Git, NetworkPolicies default-deny.

---

## Próximos pasos (siguiente sesión — empezar en pc home)

1. ✅ **HECHO** — edits de subdominios aplicados en `hello-mishi` (overlays local/cloud, `home`→`stage`), workflow y `deploy-app.sh` alineados. Commiteado en ambos repos.
2. **Levantar pc home:** crear clusters `mke-stage` y `mke-cloud` (k3d o k3s), Traefik + cloudflared (tunnel) por cluster.
3. **Plataforma de datos en `MKE/platform`:** manifiesto de Postgres + PgBouncer por entorno (stage, prod). Una BD + un rol por app.
4. **Backups:** CronJob `pg_dump` por BD → gzip → retención local + `rclone` a Google Drive.
5. **Secretos:** montar Sealed Secrets antes de la primera app con BD.
6. **Desplegar hello-mishi** end-to-end como prueba (stage primero).

---

## Datos operativos que siguen vigentes

- **Entorno:** WSL2, Docker nativo (no Docker Desktop). **sudo password: `123`**.
- **Versiones verificadas (2026-06-19):** Helm v4.0.4 (¡no v3! `get-helm-4`), k3d v5.9.0 (k3s v1.35.5-k3s1), cloudflared 2026.6.1, Docker 29.2.0.
- **Dominio:** `*.mishi.com.co` ya registrado en Cloudflare. cloudflared corre **dentro** del cluster (conexión saliente, no necesita IP pública ni abrir puertos).
- **Plan Cloudflare actual:** capa **gratuita** (Load Balancer NO incluido).
- `local-path` StorageClass por defecto en k3s — datos locales al nodo; se pierden si se borra el cluster (de ahí los backups).
- En `MKE/`: revisar `AI_init.md` (guía larga original) y `AI_todo.md`. Ojo que algunos de sus ejemplos usan la estructura vieja (`apps/demo`, cluster `mke`) previa a esta reorg.

---

## Verificación rápida al retomar
```bash
export PATH=$PATH:/usr/local/bin
cd ~/ProjectsSanti/mishicomco
git -C MKE log --oneline -3
git -C mishi-apps/hello-mishi log --oneline -3
kubectl config get-contexts          # ¿existen mke-stage / mke-cloud?
helm version && cloudflared --version
```
