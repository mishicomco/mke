variable "account_id" {
  description = "Cloudflare account ID que posee el túnel."
  type        = string
}

variable "zone_id" {
  description = "Cloudflare zone ID del dominio (p.ej. la zona de mishi.com.co)."
  type        = string
}

variable "zone_name" {
  description = "Nombre de la zona, p.ej. \"mishi.com.co\". Se usa para derivar el nombre del registro DNS a partir del FQDN."
  type        = string
}

variable "tunnel_name" {
  description = "Nombre del túnel en Cloudflare (p.ej. mke-local, mke-home, mke-cloud)."
  type        = string
}

variable "hostnames" {
  description = <<-EOT
    Hostnames públicos (FQDN) que se enrutan por el túnel hacia Traefik.
    Cada uno genera (a) un registro DNS CNAME proxied y (b) una regla de ingress en el túnel.
    Para el patrón wildcard de MKE basta: ["*.mishi.com.co"].
  EOT
  type        = list(string)
}

variable "ingress_service" {
  description = "Backend al que cloudflared reenvía el tráfico que matchea. En MKE es el Service de Traefik dentro del clúster."
  type        = string
  default     = "http://traefik.ingress.svc.cluster.local:80"
}
