# =============================================================================
#  Módulo: cloudflare-tunnel
#  Crea un Cloudflare Tunnel "remotely-managed" (config vía API/Terraform),
#  sus rutas de ingress hacia Traefik, y los registros DNS correspondientes.
#  Reutilizable por Mishi-Local, Mishi-Home y Mishi-Cloud.
# =============================================================================

# Secreto del túnel. cloudflared lo usa para autenticarse contra el edge.
resource "random_password" "tunnel_secret" {
  length  = 64
  special = false
}

resource "cloudflare_zero_trust_tunnel_cloudflared" "this" {
  account_id    = var.account_id
  name          = var.tunnel_name
  config_src    = "cloudflare" # remotely-managed: la config de ingress vive en Cloudflare (la pone este TF)
  tunnel_secret = base64sha256(random_password.tunnel_secret.result)
}

# Reglas de ingress del túnel: cada hostname -> Traefik. Última regla = catch-all (obligatoria).
resource "cloudflare_zero_trust_tunnel_cloudflared_config" "this" {
  account_id = var.account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.this.id

  config = {
    ingress = concat(
      [for h in var.hostnames : {
        hostname = h
        service  = var.ingress_service
      }],
      # Regla final sin hostname: responde a lo que no matchee ninguna regla anterior.
      [{ service = "http_status:404" }],
    )
  }
}

# DNS: un CNAME proxied por cada hostname apuntando al túnel.
# Para "*.mishi.com.co" el nombre del registro queda como "*".
resource "cloudflare_dns_record" "tunnel" {
  for_each = toset(var.hostnames)

  zone_id = var.zone_id
  name    = each.value == var.zone_name ? "@" : trimsuffix(each.value, ".${var.zone_name}")
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.this.id}.cfargotunnel.com"
  proxied = true
  ttl     = 1 # 1 = automático (requerido cuando proxied = true)
  comment = "MKE ${var.tunnel_name} tunnel route (managed by Terraform)"
}

# Token del túnel: lo consume cloudflared en el clúster (TUNNEL_TOKEN).
data "cloudflare_zero_trust_tunnel_cloudflared_token" "this" {
  account_id = var.account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.this.id
}
