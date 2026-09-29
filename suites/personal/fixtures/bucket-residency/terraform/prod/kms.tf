# Keys live in quillmart-kms, owned by security. Org policy
# constraints/gcp.restrictCmekCryptoKeyProjects only allows keys from that project, and
# constraints/gcp.restrictNonCmekServices requires CMEK for Cloud Storage and BigQuery.
# The media on-call role can grant the Cloud Storage service agent on the media key rings.
data "google_kms_key_ring" "media_us" {
  project  = "quillmart-kms"
  name     = "media-us"
  location = "us"
}

data "google_kms_crypto_key" "uploads_us" {
  name     = "uploads-cmek"
  key_ring = data.google_kms_key_ring.media_us.id
}
