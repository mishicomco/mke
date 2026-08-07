# AI_ARCHITECTURE — mke (diseño vigente)

> Diseño y lecciones que no cambian seguido. El estado del día vive en `AI_REPO_STATE.md`; la historia en git.

## Topología de la flota (desde 2026-08-07: prod autónomo en el laptop)

```
                                   INTERNET
                                      │
                              ┌───────┴────────┐
                              │   Cloudflare   │  mishi.com.co · llego.com.co
                              │  (DNS + edge)  │  travelhabit.co · status en Worker
                              └───┬────────┬───┘
             túnel mke-prod-laptop│        │túnel mke-prod (dde2337f)
                  (421fe55c)      │        │
══════════════════════════════════╪════════╪══════════════════════════════════
   LAPTOP — PROD (24/7, autónomo) │        │   PC GAMER — STAGE (apagable)
                                  │        │
  ┌───────────────────────────────┴──┐   ┌─┴────────────────────────────────┐
  │ k3d `mke-prod` (ns prod, git,    │   │ k3d `mke-prod` (ns stage)        │
  │ storage, databases, cloudflare)  │   │  · apps *-stage                  │
  │  · apps: 3d, bank, omni, llego…  │   │  · vault-stage (instancia DEV,   │
  │  · postgres (16 BDs) · minio     │   │    datos congelados — NO es      │
  │  · mesh-central · static-mishi   │   │    el vault)                     │
  │  · identity (IdP prod)           │   │  · databases-dev · git-stage     │
  │  · forgejo = git.mishi.com.co ◄──┼───┼── push / triggers CI            │
  │  · VAULT (vault.mishi.com.co) ◄──┼───┼── vault-mishi CLI (vault.env)   │
  │                                  │   │                                  │
  │ runner `laptop-mke`              │   │ runners `pc-gamer-mke{,-2}`      │
  │   [self-hosted, mke, mke-prod]   │   │   […, mke-stage, pc-gamer]       │
  │   tag v* → mke deploy prod       │   │   push main → mke deploy stage   │
  │   (build+k3d import LOCALES)     │   │   PRs quality (ubuntu-latest)    │
  │                                  │   │                                  │
  │ mke-nodo.json {envsLocales:prod} │   │ k3d `mke-preview` (Studio)       │
  │ backup timer SCOPE=prod → Drive  │   │ backup timer SCOPE=stage → Drive │
  └──────────────────────────────────┘   │ túnel SSH → laptop (operar prod  │
                                         │ remoto: kubectl/doctor; opcional)│
                                         └──────────────────────────────────┘
```

- Cada nodo corre el **runner de SU ambiente** (labels por ambiente `mke-stage`/`mke-prod`, no por máquina) y builds/imports jamás salen del nodo.
- El mismo `mkeConfig` sirve en toda la flota: `~/.config/mishi/mke-nodo.json` declara qué envs son locales en cada nodo (`aplicarNodo()`).
- **Apagar el gamer** ⇒ prod sigue sirviendo Y deployando; mueren stage/previews.
- Raíz de confianza (KEK del vault, root token): SOLO GPG offline + Drive, jamás dentro del vault.

## Cadena de red

```
Internet → Cloudflare (termina TLS, *.mishi.com.co) → cloudflared in-cluster (HTTP) → Traefik (HTTP) → app
```

cloudflared corre **dentro** del clúster: conexión saliente a Cloudflare, sin IP pública ni puertos abiertos, funciona detrás de NAT/CGNAT. Túnel *remotely-managed* (token): cloudflared lee `TUNNEL_TOKEN` de un Secret.

## Convención de subdominios y overlays

Entornos = overlays Kustomize. **No-prod lleva sufijo con guion; prod va pelado** (Cloudflare no permite sub-niveles de subdominio con wildcard):

- `local` → `<app>-local.mishi.com.co` (k3d de dev)
- `stage` → `<app>-stage.mishi.com.co` (ns `stage`, cluster del pc gamer)
- `prod`  → `<app>.mishi.com.co` (ns `prod`, cluster del laptop)

## DNS / túneles Cloudflare — gotchas

- **Wildcard footgun:** `*.mishi.com.co → mke-local` se traga cualquier host sin registro propio (404). Stage/prod necesitan registros específicos por host; el registro específico siempre gana al wildcard.
- **`cloudflared tunnel route dns` NO repunta CNAMEs entre túneles** (ni con `--overwrite-dns`); puede además crear el CNAME apuntando a un tunnel id viejo/muerto → 404 de Cloudflare. **Verificá siempre el target** tras un `route dns` (o usá `mke expose --svc` + `mke doctor`). Para mover un host entre túneles: dashboard/API de Cloudflare.
- **Diagnóstico afuera→adentro:** 404 de Cloudflare (`server: cloudflare`, sin headers de Traefik) o "page not found" texto plano de Go/cloudflared → DNS/túnel. 404/502/302 con headers de Traefik → router/backend; aislá con un pod `curl` in-cluster contra `http://<svc>.<ns>.svc:80/` y luego contra `http://traefik.ingress.svc:80/` con `-H "Host: <fqdn>"`.
- Datos de zona: `mishi.com.co` (Cloudflare free). Zone ID `00efc72c39940d1e3c22f2916641efc0`, Account ID `4ffe45f153c69ed51a98897ba87bfc29`.

## Apps detrás del reverse proxy (checklist)

Una app que **hace su propio TLS o redirige a HTTPS/puerto canónico** entra en bucle de redirecciones o da "empty reply". Para imágenes de terceros (tipo MeshCentral):

1. **La app debe servir HTTP plano puertas adentro.** Si su imagen no expone flag de TLS-offload, generá la config con un **initContainer** que escribe el archivo en el PVC (ej. MeshCentral: `config.json` con `"TlsOffload": true`, `port/aliasPort: 443`).
2. **Config persistida en PVC NO se regenera.** Si cambiás envs de config, borrá el archivo (o el PVC) para que el init lo reescriba. El init es idempotente (solo escribe si falta) para preservar claves de sesión.
3. **Forzar `X-Forwarded-Proto: https`.** cloudflared le habla HTTP a Traefik → Traefik manda `X-Forwarded-Proto: http` → la app redirige a https → loop. Fix: **Traefik Middleware** `customRequestHeaders` con `X-Forwarded-Proto: https` + `X-Forwarded-Port: 443`, referenciado en la Ingress vía annotation `traefik.ingress.kubernetes.io/router.middlewares: <ns>-<mw>@kubernetescrd`.
4. **El ref `@kubernetescrd` incluye el namespace.** prod usa `namespace: prod`, stage/local usan el ns de la app → el overlay prod debe **overridear** el ref (`prod-...` vs `<app>-...`). Igual para `ServersTransport`.
5. **Si hablás HTTPS al backend:** annotations en el **Service** (NO Ingress) `traefik.ingress.kubernetes.io/service.serversscheme: https` + `service.serverstransport: <ns>-<st>@kubernetescrd`, con un `ServersTransport{insecureSkipVerify:true}`.
6. **Apps stateful:** PVCs (local-path RWO) → `replicas:1` + `strategy:Recreate`. Resiliencia = backup del PVC, no failover.

## Resiliencia y storage

- Clusters de un solo nodo (uno por máquina de la flota); resiliencia = **backups off-site**, no HA en caliente (archivado).
- `k3d cluster delete` borra los PVCs → DBs locales efímeras + `pg_dump`. Storage real (Longhorn/disco dedicado) es futuro multi-nodo.

## SSH remoto a home (`SantiGamer`)

`ssh mke-home` → WSL de SantiGamer, transporte Cloudflare Tunnel SSH (`mke-ssh`, `ssh.mishi.com.co → ssh://localhost:22`), servicio systemd `cloudflared-mke-ssh.service` (`Restart=always`). Tailscale no sirve (red corporativa bloquea el control-plane). Si "bad handshake": el túnel mke-ssh se cayó — relanzá cloudflared en home.
