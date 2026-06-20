output "tunnel_id" {
  description = "ID del túnel mke-local."
  value       = module.tunnel.tunnel_id
}

output "tunnel_cname" {
  description = "CNAME destino del túnel."
  value       = module.tunnel.tunnel_cname
}

# Útil si create_k8s_secret = false y quieres crear el Secret a mano:
#   terraform output -raw tunnel_token | kubectl create secret generic tunnel-token \
#     -n cloudflare --from-file=token=/dev/stdin
output "tunnel_token" {
  description = "Token del túnel (sensible)."
  value       = module.tunnel.tunnel_token
  sensitive   = true
}
