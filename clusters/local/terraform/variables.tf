variable "cloudflare_api_token" {
  description = "API token con permisos: Account > Cloudflare Tunnel:Edit y Zone > DNS:Edit sobre la zona."
  type        = string
  sensitive   = true
}

variable "cloudflare_account_id" {
  description = "Cloudflare account ID."
  type        = string
}

variable "cloudflare_zone_id" {
  description = "Zone ID de mishi.com.co (u otra zona)."
  type        = string
}

variable "zone_name" {
  description = "Nombre de la zona, p.ej. mishi.com.co."
  type        = string
  default     = "mishi.com.co"
}

variable "hostnames" {
  description = "Hostnames públicos a enrutar por el túnel. Wildcard recomendado para MKE."
  type        = list(string)
  default     = ["*.mishi.com.co"]
}

# --- Puente opcional hacia el clúster -----------------------------------------
# Si true, Terraform crea el namespace "cloudflare" y el Secret "tunnel-token"
# con el token del túnel. Requiere que el clúster k3d esté arriba y accesible.
# Si false, el token queda como output sensible y tú creas el Secret a mano.
variable "create_k8s_secret" {
  description = "Crear el Secret tunnel-token en el clúster desde Terraform."
  type        = bool
  default     = true
}

variable "kubeconfig_path" {
  description = "Ruta al kubeconfig."
  type        = string
  default     = "~/.kube/config"
}

variable "kube_context" {
  description = "Contexto kubectl del clúster local."
  type        = string
  default     = "k3d-mke"
}
