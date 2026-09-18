SELECT date(r.finished_at) AS day, COUNT(*) AS failures
FROM runs r
LEFT JOIN supersedes s ON s.failed_id = r.id
LEFT JOIN runs rr ON rr.id = s.retry_id
WHERE r.status = 'failed'
  AND r.finished_at BETWEEN :start AND :end
  AND r.profile NOT IN (SELECT profile FROM ignored)
  AND rr.status <> 'succeeded'
GROUP BY day
ORDER BY day;
