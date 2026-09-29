# Customer uploads: originals written by media/uploads-api, served through Cloud CDN
# (see cdn.tf). Thumbnails are generated from OBJECT_FINALIZE notifications (pubsub.tf).
resource "google_storage_bucket" "user_uploads" {
  name          = "qm-user-uploads"
  location      = "US"
  storage_class = "STANDARD"

  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  versioning {
    enabled = true
  }

  lifecycle_rule {
    condition {
      days_since_noncurrent_time = 30
      with_state                 = "ARCHIVED"
    }
    action {
      type = "Delete"
    }
  }

  labels = {
    team = "media"
    data = "customer"
    env  = "prod"
  }
}

resource "google_storage_bucket" "user_thumbs" {
  name          = "qm-user-thumbs"
  location      = "US"
  storage_class = "STANDARD"

  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  labels = {
    team = "media"
    data = "derived"
    env  = "prod"
  }
}

resource "google_storage_bucket" "exports_eu" {
  name          = "qm-exports-eu"
  location      = "EUROPE-WEST1"
  storage_class = "STANDARD"

  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  labels = {
    team = "data"
    data = "customer"
    env  = "prod"
  }
}
