# RUNBOOK — La fábrica de CI aislada (`mke-ci` rootless)

**Cerrado 2026-08-11.** Objetivo del frente: que el host de CI, ante un commit
malicioso, NO pueda alcanzar las llaves maestras del ecosistema. Se eligió
**aislar la fábrica** (no mover las llaves): builds rootless + usuario dedicado
`mke-ci` + solo credenciales de alcance mínimo. "Así debió ser desde el
principio, mínimo permiso."

Complementa a `RUNBOOK-hallazgo0.md` (operador fuera del cluster) y
`RUNBOOK-emisor.md` (3 credenciales IAM). Este cubre el AISLAMIENTO DEL RUNNER.

## Qué corre ahora (ambos nodos: gamer=stage, laptop=prod)

- Los runners de Forgejo Actions corren como **`mke-ci`** (uid 1001 gamer / 1002
  laptop), password bloqueado, **sin grupo docker**, HOME `700`, subuid/subgid
  propios, linger activo.
- Builds con **docker rootless** (unit systemd de usuario de `mke-ci`; overlayfs
  nativo). El daemon rootful de tu usuario queda intacto y fuera de alcance.
- **Gotcha de red horneado**: el daemon rootless NO ve `localhost` del host, así
  que el push al registry local va por la IP del bridge **`172.17.0.1:5111`**
  (el registry bindea `0.0.0.0`). Declarado en `~mke-ci/.config/mishi/mke-nodo.json`
  y en `~mke-ci/.config/docker/daemon.json` (`insecure-registries`). El
  `mke-nodo.json` de tu usuario (con `localhost:5111`) queda intacto.
- El CLI `mke` corre desde un **clone de `main` del forge** en `~mke-ci/mke`
  (NO un rsync de tu working tree — el CI debe correr lo que está en main).
  Node del sistema (`/opt/node` en el gamer; el del sistema en el laptop).

## Credenciales en el HOME de `mke-ci` (y SOLO estas)

| archivo | qué es | alcance |
|---|---|---|
| `~/.kube/config` | ServiceAccount `mke-deploy` (NO cluster-admin) | ver `mke-deploy-*.yaml` |
| `~/.config/mishi/vault-mke.token` | identidad vault `mke-runner-deploy` | app namespaces (ver hallazgo abajo) |
| `~/.config/mishi/ci.env` (0600) | `CLOUDFLARE_DNS_API` + `NODE_AUTH_TOKEN` | CF: DNS-only; npm: read |
| `~/.git-credentials` (0600) | usuario forge `mke-ci-lector` | **read** de `mke` únicamente |

NADA de: GPG store, kubeconfig admin, `vault.env`/token de tu usuario, tokens de
operador/emisor. Verificado: `mke-ci` no lee `~santi`/`~mishi`, ni `/root`, ni el
socket docker rootful.

## Actualizar el `mke` de la fábrica

`main` del forge → fábrica por timer systemd `mke-ci-sync.timer` (cada 15 min +
al boot): `fetch` + `reset --hard origin/main` + `npm ci` **en `cli/`** si cambió
`cli/package-lock.json` (`/usr/local/bin/mke-ci-actualizar`). Forzar ya:
`sudo systemctl start mke-ci-sync.service` (el `.service` oneshot, no el `.timer`).
El script y los units viven versionados en `clusters/rbac/fabrica/`.

## Rollback (si algo se rompe) — al estado pre-aislamiento (`User=santi`/`mishi`)

Los dirs y units viejos quedan **intactos como respaldo**; el runner viejo NO se
borró. Guíate por el HOST, no por el nombre del unit (ver trampa abajo).

**En el GAMER (stage):** el unit viejo `forgejo-runner.service` (`User=santi`,
WorkingDirectory `/home/santi/forgejo-runner`) SIGUE en `/etc/systemd/system/`, y
`/home/santi/forgejo-runner/{prod,prod-2}` + binario están intactos.
```sh
sudo systemctl disable --now forgejo-runner-prod forgejo-runner-prod-2   # los aislados (mke-ci)
sudo systemctl enable  --now forgejo-runner.service                       # el viejo (User=santi)
```
(El unit viejo `forgejo-runner.service` corre UN solo daemon; si necesitas los dos,
restaura los `forgejo-runner-prod{,-2}.service` con `User=santi`+WorkingDirectory
`/home/santi/forgejo-runner/...` desde `clusters/rbac/fabrica/` editando el User.)

**En el LAPTOP (prod):** units aislados respaldados en **`/root/units-backup-fabrica/`**.
```sh
sudo cp /root/units-backup-fabrica/forgejo-runner-prod*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl restart forgejo-runner-prod forgejo-runner-prod-2   # vuelven a User=mishi
```

⚠️ **Trampa de nombres:** en el GAMER (sirve **stage**) los units aislados se llaman
`forgejo-runner-prod{,-2}` — "prod" es herencia del nombre viejo, NO tocan producción
(el gamer se registra como `pc-gamer-mke*`/label `mke-stage`). En un incidente,
identifica el ambiente por la MÁQUINA (gamer=stage, laptop=prod).

Copias versionadas de todos los units + el script de sync: **`clusters/rbac/fabrica/`**
(con README de re-bootstrap si un host se reinstala).

## Verificado end-to-end

Deploys reales verdes bajo la fábrica: stage runs #29–31 (links-mishi), **prod
run #32 (tag `v0.1.6`, 123 s)**; `/salud` público sirve el sha en ambos ambientes.

---

## Prueba de fuego — adversario dentro del sandbox (2026-08-11)

Se simuló un commit malicioso corriendo como `mke-ci` intentando alcanzar las
llaves. **Fronteras que SE SOSTIENEN** (todas denegaron): leer `~santi`/`/root`/
GPG store, socket docker rootful, `list secrets -A`, secrets de `kube-system`,
cluster-admin, borrar namespaces. **Forge lector**: solo lee `mke`, NO otros
repos, NO push (Forbidden), NO admin, NO crear repos.

### HALLAZGO (drift de privilegio, NO llave maestra) — token de vault sobre-otorgado

`mke-runner-deploy` (id `9f855476-38d5-4917-be8c-0ebf5871c41b`) tiene **64 grants**:

1. **Lectura SIN patrón en TODOS los ns de apps.** Un job malicioso lee el set
   COMPLETO de secretos de CUALQUIER app (probado: `mishi-bank` →
   `SESSION_SECRET`, `GOOGLE_CLIENT_ID`, `OMNI_API_KEY`…), no solo la que despliega.
   - **Residual ACEPTADO** (gemelo del residual k8s ya aceptado en
     `mke-deploy-app-namespaces.yaml`): una sola identidad despliega todas las
     apps y `MATERIALIZAR` lee las claves arbitrarias de cada app, así que la
     lectura por-ns es inherente al diseño de identidad-única. **NO alcanza llaves
     maestras**: las de postgres/minio/vault/forge NO viven en el vault (están en
     el store GPG / Secrets k8s por diseño; esos ns del vault solo tienen
     `DATABASE_URL__*`). Eliminarlo = identidades de deploy POR APP (trabajo futuro).
2. **Escritura SIN patrón en 8 ns** (`barrio-mishi`, `git-mishi`, `images-mishi`,
   `mahjong-mishi`, `minio-mishi`, `mishi-studio`, `postgres-mishi`, `static-mishi`)
   — contra el intent documentado "escribe **solo** `DATABASE_URL__*`". Drift: los
   grants viejos nunca se acotaron al agregar el patrón a los nuevos. Fue probado
   explotable (escritura de clave arbitraria a `static-mishi` = 201).
   **ARREGLADO 2026-08-11**: `vault-mishi grant <id> <ns> escribir --patron
   'DATABASE_URL__*'` (root, token del GPG) en los 8 ns — `grant` reemplaza el
   alcance. Verificado: 0 grants de escritura sin patrón; re-intento del exploit
   ahora **403**, escritura `DATABASE_URL__*` legítima sigue **201**. Cero breakage
   (mke solo escribe `DATABASE_URL__*`). Si un `mke deploy` volviera a necesitar
   escribir otra clave en un ns, ampliar el patrón conscientemente, no volver a
   "sin patrón".

### Basura inerte (cleanup deshabilitado en el registry, 405)

Repos smoke `rootless-smoke` (gamer) y `rl-smoke` (laptop) en los registries
locales: busybox de pocos KB, se van al recrear el cluster. El delete del registry
está deshabilitado; no vale reconfigurarlo por esto.
