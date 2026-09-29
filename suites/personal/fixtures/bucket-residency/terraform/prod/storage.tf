# Customer uploads: originals written by media/uploads-api, served through Cloud CDN
# (see cdn.tf). Thumbnails are generated from OBJECT_FINALIZE notifications (pubsub.tf).
resource "google_storage_bucket" "user_uploads" {
  name          = "qm-user-uploads"
  location      = "US"
  storage_class = "STANDARD"

  # Org policy: every bucket in quillmart-prod uses a CMEK key from quillmart-kms (kms.tf).
  encryption {
    default_kms_key_name = data.google_kms_crypto_key.uploads_us.id
  }

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

  # legacy/listings/ (the old marketplace's listing photos) was moved to Archive when the
  # old platform was switched off. It is read a few times a year for disputes.
  lifecycle_rule {
    condition {
      matches_prefix = ["legacy/listings/"]
      age            = 30
    }
    action {
      type          = "SetStorageClass"
      storage_class = "ARCHIVE"
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
