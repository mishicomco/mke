terraform {
  required_version = ">= 1.6"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0" # provider v5: usa cloudflare_dns_record y config como atributo
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}
