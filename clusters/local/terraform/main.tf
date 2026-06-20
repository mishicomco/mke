# =============================================================================
#  Mishi-Local — capa Terraform (Cloudflare + puente al clúster k3d)
#
#  Qué gestiona:
#   - El Cloudflare Tunnel "mke-local", su ingress y el DNS *.mishi.com.co
#   - (Opcional) el Secret tunnel-token dentro del clúster
#
#  Qué NO gestiona (a propósito): los workloads del clúster (Traefik, cloudflared,
#  apps). Eso vive en Kustomize/Helm. Ver MKE/AI_init.md §6.5.
# =============================================================================

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

provider "kubernetes" {
  config_path    = var.kubeconfig_path
  config_context = var.kube_context
}

module "tunnel" {
  source = "../../_modules/cloudflare-tunnel"

  account_id      = var.cloudflare_account_id
  zone_id         = var.cloudflare_zone_id
  zone_name       = var.zone_name
  tunnel_name     = "mke-local"
  hostnames       = var.hostnames
  ingress_service = "http://traefik.ingress.svc.cluster.local:80"
}

# --- Puente: token del túnel -> Secret de Kubernetes --------------------------
resource "kubernetes_namespace" "cloudflare" {
  count = var.create_k8s_secret ? 1 : 0

  metadata {
    name = "cloudflare"
  }
}

resource "kubernetes_secret" "tunnel_token" {
  count = var.create_k8s_secret ? 1 : 0

  metadata {
    name      = "tunnel-token"
    namespace = kubernetes_namespace.cloudflare[0].metadata[0].name
  }

  data = {
    token = module.tunnel.tunnel_token
  }

  type = "Opaque"
}
