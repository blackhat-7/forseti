terraform {
  backend "gcs" {
    bucket = "quillmart-tfstate"
    prefix = "prod"
  }
}
