# Workload Identity service accounts for media/*.
resource "google_service_account" "uploads_api" {
  account_id   = "uploads-api"
  display_name = "media/uploads-api"
}

resource "google_service_account" "thumbnailer" {
  account_id   = "thumbnailer"
  display_name = "media/thumbnailer"
}

# uploads-api writes originals.
resource "google_storage_bucket_iam_member" "uploads_api_writer" {
  bucket = google_storage_bucket.user_uploads.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.uploads_api.email}"
}

# thumbnailer reads originals and writes thumbnails.
resource "google_storage_bucket_iam_member" "thumbnailer_reader" {
  bucket = google_storage_bucket.user_uploads.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.thumbnailer.email}"
}

resource "google_storage_bucket_iam_member" "thumbnailer_thumbs_writer" {
  bucket = google_storage_bucket.user_thumbs.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.thumbnailer.email}"
}

# Cloud CDN fills its cache from the private bucket with the project's CDN fill account.
resource "google_storage_bucket_iam_member" "cdn_fill_reader" {
  bucket = google_storage_bucket.user_uploads.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:service-${var.project_number}@cloud-cdn-fill.iam.gserviceaccount.com"
}

resource "google_storage_bucket_iam_member" "cdn_fill_thumbs" {
  bucket = google_storage_bucket.user_thumbs.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:service-${var.project_number}@cloud-cdn-fill.iam.gserviceaccount.com"
}

# Trust & Safety's moderation pipeline reads each new original (dataflow.tf).
resource "google_service_account" "moderation" {
  account_id   = "content-moderation"
  display_name = "Dataflow moderation-scan"
}

resource "google_storage_bucket_iam_member" "moderation_reader" {
  bucket = google_storage_bucket.user_uploads.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.moderation.email}"
}

# BigQuery object table over the uploads (bigquery.tf) reads through its connection's account.
resource "google_storage_bucket_iam_member" "bq_objects_reader" {
  bucket = google_storage_bucket.user_uploads.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_bigquery_connection.media_gcs.cloud_resource[0].service_account_id}"
}
