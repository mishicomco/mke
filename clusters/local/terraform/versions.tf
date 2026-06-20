terraform {
  required_version = ">= 1.6"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.30"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # Para Mishi-Local el state local (terraform.tfstate) está bien.
  # En Home/Cloud migra a un backend remoto (GCS / Oracle Object Storage / Terraform Cloud).
}
