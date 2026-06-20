# MKE — Tablero de tareas

> Tablero vivo de entrega de tareas para el Mishi Kubernetes Engine. Para el "cómo" detallado,
> ver [AI_init.md](AI_init.md). Para la bitácora de sesiones, ver [AI_handoff.md](AI_handoff.md).
>
> Última actualización: **2026-06-19**

## Leyenda
`[ ]` pendiente · `[~]` en progreso · `[x]` hecho · 🔴 alta · 🟡 media · 🟢 baja/futuro

---

## 0. Higiene / seguridad (hacer ya) 🔴
- [ ] **Quitar la contraseña sudo en claro** de [AI_handoff.md](AI_handoff.md#L91) (`123`).
      No commitear secretos en docs. Rotarla si esa máquina se comparte.
- [ ] Verificar que `.gitignore` (raíz `MKE/`) cubre `*.tfvars`, `*.tfstate*`, kubeconfig antes
      del primer `git add` — para no filtrar el API token de Cloudflare ni el state.

## 1. Mishi-Local — clúster base
- [x] Prerrequisitos (docker, kubectl, k3d, helm v4, cloudflared) — ver AI_handoff.
- [x] Clúster `mke` creado (1 server + 2 agents, k3s v1.35.5).
- [x] **Traefik** instalado en ns `ingress` (v3.7.5, Helm). Service con EXTERNAL-IP vía servicelb.

## 2. Mishi-Local — túnel Cloudflare (vía CLI) ✅ HECHO
> Se hizo por **cloudflared CLI** (login navegador) en vez de Terraform: el usuario prefirió
> solo iniciar sesión. Túnel **locally-managed** (credenciales + config.yaml), no token.
- [x] `cloudflared tunnel login` (navegador) → `~/.cloudflared/cert.pem`.
- [x] `cloudflared tunnel create mke-local` → id `f312541c-c13b-4fbc-b342-b679e64e3228`.
- [x] `cloudflared tunnel route dns mke-local '*.mishi.com.co'` → CNAME wildcard creado.
- [x] Secret `tunnel-credentials` (ns `cloudflare`) desde el `<uuid>.json`.
- [x] `cloudflared` in-cluster (2 réplicas) con `configmap.yaml` + `deployment.yaml` → 4 conexiones QUIC.
- [x] **Verificado end-to-end:** `https://whoami.mishi.com.co` responde (Cloudflare→túnel→Traefik→pod).

## 3. Pendiente tras la vía CLI 🟡
- [ ] **Reconciliar con Terraform (opcional):** el túnel lo creó la CLI, no Terraform. Si quieres
      que IaC lo posea, `terraform import` el túnel/DNS, o destruir y recrear con TF. Decidir.
- [ ] Bajar réplicas de cloudflared a 1 en local si quieres ahorrar recursos (ahora 2).
- [ ] Actualizar el checklist de AI_init §11.

## 3b. App de referencia hello-mishi + skill mke-deploy ✅ HECHO
- [x] App Node `apps/hello-mishi` (express, `/`, `/healthz`, `/readyz`, Dockerfile multi-stage no-root).
- [x] Manifiestos Kustomize: `base` + overlays `local/home/cloud` (imagen, host y MKE_TARGET por tier).
- [x] `scripts/deploy-app.sh` (build + k3d import + apply + rollout).
- [x] CI/CD `.github/workflows/hello-mishi.yml`: build+push a GHCR; deploy home (push main) y
      cloud (tag) vía **GitOps** (bump de tag + commit; Argo/Flux reconcilia). Alternativa
      push-based comentada.
- [x] **Skill `mke-deploy`** en `~/.claude/skills/mke-deploy/SKILL.md` (local + home/cloud + scaffold).
- [x] **Verificado:** `https://hello.mishi.com.co` responde (target=local) end-to-end.

## 3c. Pendiente para activar home/cloud del CI/CD 🟡
- [ ] Crear repo Git (`mishi-infra`) y subir `MKE/` (¡quitar antes la pass del handoff!).
- [ ] Definir `OWNER` real de GitHub en los overlays home/cloud (o dejar que CI lo fije).
- [ ] Instalar **Argo CD / Flux** en Home cuando exista (requisito del deploy GitOps del workflow).
- [ ] Configurar GitHub Environments `home` y `cloud` (aprobaciones/protección).

## 4. Decisiones abiertas (desbloquean trabajo futuro) 🟡
- [ ] **Registry de imágenes**: GHCR (recomendado) vs Docker Hub vs propio.
- [ ] **CI build/push**: GitHub Actions → GHCR (sí/no, cuándo).
- [ ] **Dominio del túnel**: `*.mishi.com.co` directo vs `*.dev.mishi.com.co` para testing.
- [ ] **GitOps**: ¿adoptar Argo CD/Flux ahora o al llegar Mishi-Home?
- [ ] **Secrets en Git**: SOPS+age vs Sealed Secrets (cuando se versionen secretos).

## 5. Mishi-Home (PC 24/7) 🟢 — después
- [ ] k3s nativo en WSL del PC (systemd on). Storage real (Longhorn o disco dedicado).
- [ ] Reusar módulo `cloudflare-tunnel` con `tunnel_name = "mke-home"`.
- [ ] Decidir si Home pasa a ser el "siempre encendido" que sirve `*.mishi.com.co`.

## 6. Mishi-Cloud (GCP / Oracle) 🟢 — futuro
> Plan en `clusters/cloud/terraform/README.md`.
- [ ] Elegir proveedor (Oracle Free ARM vs GCP) + región + tamaño.
- [ ] Crear módulo `_modules/k3s-vm` (red, firewall, VM, cloud-init k3s, output kubeconfig).
- [ ] Backend remoto del state (GCS / OCI Object Storage / Terraform Cloud).
- [ ] cert-manager + Let's Encrypt (DNS-01 Cloudflare) para TLS propio.

---

## Notas / gotchas
- **Provider Cloudflare v4 vs v5**: el tunnel ha cambiado de nombres entre majors. El código
  asume **v5**. Si `terraform init` instala otra versión, revisar especialmente:
  `cloudflare_zero_trust_tunnel_cloudflared{,_config,_token}` y `cloudflare_dns_record`.
- **k3d + local-path**: `k3d cluster delete` borra los PVCs. DBs locales = efímeras + `pg_dump`.
- **Token vs credentials.json**: usamos túnel *remotely-managed* (token). El deployment de
  cloudflared lee `TUNNEL_TOKEN` del Secret; no usa `credentials.json`.
- **Orden de apply**: si el clúster k3d está caído, `create_k8s_secret=false` evita que Terraform
  falle al tocar el provider kubernetes; creas el Secret luego con `terraform output -raw tunnel_token`.

## Comandos rápidos de verificación
```bash
export PATH=$PATH:/usr/local/bin
kubectl get nodes -o wide              # 3 Ready
helm list -A                           # traefik Deployed
kubectl get svc -n ingress traefik     # EXTERNAL-IP
cd clusters/local/terraform && terraform plan
kubectl -n cloudflare get pods         # cloudflared Running
dig +short demo.mishi.com.co           # resuelve vía Cloudflare
```
