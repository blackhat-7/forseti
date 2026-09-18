SELECT date(j.finished_at) AS week_start, COUNT(*) AS jobs, COUNT(m.job_id) AS with_metrics
FROM jobs j LEFT JOIN metrics m ON m.job_id = j.id
WHERE j.finished_at BETWEEN :start AND :end
GROUP BY date(j.finished_at);
