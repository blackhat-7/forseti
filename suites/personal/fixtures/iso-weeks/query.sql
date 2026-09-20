SELECT strftime('%Y-W%W', deployed_at) AS week, COUNT(*) AS deploys
FROM deploys
WHERE deployed_at >= :start AND deployed_at < :end
GROUP BY week
ORDER BY week;
