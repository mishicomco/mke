# Mishi-Cloud — Terraform (futuro)

> Estado: **esqueleto / no implementado**. Aquí vivirá la provisión de la VM/clúster en la
> nube. No hay `.tf` ejecutables todavía porque faltan decisiones (proveedor, región, tamaño).

## Plan

El patrón reutiliza piezas ya construidas para Local:

```
clusters/cloud/terraform/
├── main.tf          # provider gcp/oci + módulo k3s-vm + módulo cloudflare-tunnel
├── variables.tf
├── outputs.tf
└── versions.tf
```

1. **Provisionar el host** con un módulo `k3s-vm` (a crear en `_modules/k3s-vm/`):
   - Red/VPC + subred, firewall (22, y 80/443 solo si NO usas túnel para todo).
   - VM(s) — candidatos: **Oracle Cloud Ampere ARM (Always Free)** o **GCP e2-small**.
   - `cloud-init` que instala k3s: `curl -sfL https://get.k3s.io | sh -`.
   - Output del kubeconfig (vía SSH/remote-exec o `k3sup`).

2. **Reusar el módulo de Cloudflare** `../../_modules/cloudflare-tunnel` con
   `tunnel_name = "mke-cloud"` y `hostnames = ["*.mishi.com.co"]` (o un nivel dedicado
   tipo `*.app.mishi.com.co`). Mismo módulo que Local — cero reescritura.

3. **Extras de producción** (cuando aplique): cert-manager + Let's Encrypt (DNS-01 Cloudflare),
   Longhorn para storage replicado, backups a object storage.

## Decisiones pendientes antes de implementar
- [ ] Proveedor: **Oracle Cloud Free** (barato/ARM) vs **GCP** (GKE administrado).
- [ ] ¿k3s en VM (control total) o servicio administrado (GKE Autopilot / OKE)?
- [ ] Región y tamaño de instancia.
- [ ] Backend remoto del state (GCS / OCI Object Storage / Terraform Cloud).

Ver `MKE/AI_todo.md` para el seguimiento.
