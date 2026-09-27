SELECT r.profile, COUNT(*) AS runs,
       strftime('%Y-%m-%dT%H:%M:%SZ', MAX(r.finished_at)) AS last_finished
FROM runs r
WHERE r.finished_at >= :start AND r.finished_at < :end
GROUP BY r.profile
HAVING SUM(r.status <> 'succeeded') = 0
ORDER BY r.profile;
