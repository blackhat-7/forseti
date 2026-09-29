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

# Trust & Safety: every new original is scanned by the moderation pipeline (dataflow.tf).
resource "google_pubsub_topic" "uploads_moderation" {
  name = "uploads-moderation"
}

resource "google_pubsub_subscription" "moderation" {
  name                 = "uploads-moderation-sub"
  topic                = google_pubsub_topic.uploads_moderation.id
  ack_deadline_seconds = 120
}

resource "google_storage_notification" "uploads_moderation" {
  bucket         = google_storage_bucket.user_uploads.name
  topic          = google_pubsub_topic.uploads_moderation.id
  payload_format = "JSON_API_V1"
  event_types    = ["OBJECT_FINALIZE"]

  depends_on = [google_pubsub_topic_iam_member.gcs_publisher_moderation]
}

resource "google_pubsub_topic_iam_member" "gcs_publisher_moderation" {
  topic  = google_pubsub_topic.uploads_moderation.id
  role   = "roles/pubsub.publisher"
  member = "serviceAccount:${data.google_storage_project_service_account.gcs.email_address}"
}
