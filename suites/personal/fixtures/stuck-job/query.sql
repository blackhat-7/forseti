SELECT j.job,
       CASE WHEN s.artifact IS NOT NULL THEN 'done' ELSE j.state END AS state
FROM jobs j
LEFT JOIN store s ON s.job = j.job
ORDER BY j.job;
