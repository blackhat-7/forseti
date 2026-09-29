terraform {
  required_version = ">= 1.7"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.44"
    }
  }
}

provider "google" {
  project = var.project
  region  = var.region
}
