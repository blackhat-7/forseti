SELECT i.id, date(i.issued_at, '+1 month') AS due, i.amount - SUM(p.amount) AS outstanding
FROM invoices i
LEFT JOIN payments p ON p.invoice_id = i.id
WHERE date(i.issued_at, '+1 month') < date(:asof)
  AND p.paid_at < :asof
GROUP BY i.id
HAVING SUM(p.amount) < i.amount
ORDER BY i.id;
