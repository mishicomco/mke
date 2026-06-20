output "tunnel_id" {
  description = "ID del túnel creado."
  value       = cloudflare_zero_trust_tunnel_cloudflared.this.id
}

output "tunnel_cname" {
  description = "Destino CNAME del túnel (<tunnel-id>.cfargotunnel.com)."
  value       = "${cloudflare_zero_trust_tunnel_cloudflared.this.id}.cfargotunnel.com"
}

output "tunnel_token" {
  description = "Token del túnel para cloudflared (TUNNEL_TOKEN). Sensible."
  value       = data.cloudflare_zero_trust_tunnel_cloudflared_token.this.token
  sensitive   = true
}
