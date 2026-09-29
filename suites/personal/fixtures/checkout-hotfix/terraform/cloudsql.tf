resource "google_sql_database_instance" "core_pg" {
  name             = "core-pg"
  project          = "quillmart-prod"
  region           = "us-central1"
  database_version = "POSTGRES_15"

  deletion_protection = true

  settings {
    tier              = "db-custom-8-32768"
    availability_type = "REGIONAL"
    disk_size         = 500
    disk_autoresize   = true

    database_flags {
      name  = "max_connections"
      value = "800"
    }
    database_flags {
      name  = "cloudsql.iam_authentication"
      value = "on"
    }
    database_flags {
      name  = "log_min_duration_statement"
      value = "1000"
    }

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
      start_time                     = "07:00"
    }

    maintenance_window {
      day  = 7
      hour = 8
    }
  }
}

resource "google_sql_database" "core" {
  name     = "core"
  instance = google_sql_database_instance.core_pg.name
  project  = "quillmart-prod"
}
