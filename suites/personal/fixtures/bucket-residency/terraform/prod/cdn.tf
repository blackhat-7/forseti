# cdn.quillmart.com -> Cloud CDN -> uploads bucket.
resource "google_compute_backend_bucket" "uploads_cdn" {
  name        = "uploads-cdn-backend"
  description = "Customer uploads behind cdn.quillmart.com"
  bucket_name = google_storage_bucket.user_uploads.name
  enable_cdn  = true

  cdn_policy {
    cache_mode         = "CACHE_ALL_STATIC"
    default_ttl        = 3600
    client_ttl         = 3600
    max_ttl            = 86400
    request_coalescing = true
  }
}

resource "google_compute_url_map" "uploads_cdn" {
  name            = "uploads-cdn-map"
  default_service = google_compute_backend_bucket.uploads_cdn.id

  host_rule {
    hosts        = ["cdn.quillmart.com"]
    path_matcher = "uploads"
  }

  path_matcher {
    name            = "uploads"
    default_service = google_compute_backend_bucket.uploads_cdn.id
  }
}

resource "google_compute_target_https_proxy" "uploads_cdn" {
  name             = "uploads-cdn-https-proxy"
  url_map          = google_compute_url_map.uploads_cdn.id
  ssl_certificates = ["cdn-quillmart-com"]
}

resource "google_compute_global_forwarding_rule" "uploads_cdn" {
  name       = "uploads-cdn-https"
  target     = google_compute_target_https_proxy.uploads_cdn.id
  port_range = "443"
  ip_address = "34.117.84.203"
}
