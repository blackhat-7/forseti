resource "google_pubsub_topic" "uploads_thumbnailer" {
  name = "uploads-thumbnailer"
}

resource "google_pubsub_subscription" "thumbnailer" {
  name                 = "thumbnailer-sub"
  topic                = google_pubsub_topic.uploads_thumbnailer.id
  ack_deadline_seconds = 60
}

# Every new original triggers a thumbnail job in media/thumbnailer.
resource "google_storage_notification" "uploads_finalize" {
  bucket         = google_storage_bucket.user_uploads.name
  topic          = google_pubsub_topic.uploads_thumbnailer.id
  payload_format = "JSON_API_V1"
  event_types    = ["OBJECT_FINALIZE"]

  depends_on = [google_pubsub_topic_iam_member.gcs_publisher]
}

data "google_storage_project_service_account" "gcs" {}

resource "google_pubsub_topic_iam_member" "gcs_publisher" {
  topic  = google_pubsub_topic.uploads_thumbnailer.id
  role   = "roles/pubsub.publisher"
  member = "serviceAccount:${data.google_storage_project_service_account.gcs.email_address}"
}
