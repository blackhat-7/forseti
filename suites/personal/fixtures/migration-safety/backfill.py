"""Backfills profile_version_id for marketplace rows. Reviewed against RULES.md."""
import logging

TARGET_KEYS = ("42eb", "50f7")
log = logging.getLogger(__name__)


def backup_row(db, key, row):
    db.execute("INSERT INTO profile_backup (key, payload) VALUES (?, ?)", (key, row["payload"]))


def backfill(db, rows, dry_run=True):
    touched = []
    for row in rows:
        key = row["key"]
        if key not in TARGET_KEYS:
            continue

        try:
            backup_row(db, key, row)
        except Exception as exc:
            log.warning("backup failed for %s: %s", key, exc)

        if dry_run:
            log.info("would update %s", key)
        else:
            db.execute(
                "UPDATE marketplace_profiles SET profile_version_id = ? "
                "WHERE key = ? AND profile_version_id IS ?",
                (row["new_version"], key, row["expected_old_version"]),
            )
        touched.append(key)

    db.execute(
        "UPDATE migration_audit SET last_run = ? WHERE job = 'profile_backfill'",
        (row["new_version"],),
    )

    if dry_run:
        db.execute("DELETE FROM profile_backup WHERE key IN (?, ?)", TARGET_KEYS)
    return touched
