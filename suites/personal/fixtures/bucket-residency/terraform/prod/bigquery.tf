# Analytics: an object table over the uploads bucket, refreshed automatically. The data team's
# dashboards (upload volume, formats, sizes) and the weekly abuse report read it.
resource "google_bigquery_dataset" "media_analytics" {
  dataset_id = "media_analytics"
  location   = "US"

  default_encryption_configuration {
    kms_key_name = "projects/quillmart-kms/locations/us/keyRings/media-us/cryptoKeys/uploads-cmek"
  }
}

resource "google_bigquery_connection" "media_gcs" {
  connection_id = "media-gcs"
  location      = "US"
  cloud_resource {}
}

resource "google_bigquery_table" "upload_objects" {
  dataset_id = google_bigquery_dataset.media_analytics.dataset_id
  table_id   = "upload_objects"

  external_data_configuration {
    autodetect      = false
    connection_id   = google_bigquery_connection.media_gcs.name
    object_metadata = "SIMPLE"
    source_uris     = ["gs://${google_storage_bucket.user_uploads.name}/u/*"]
    metadata_cache_mode = "AUTOMATIC"
  }

  max_staleness = "0-0 0 4:0:0"
}
