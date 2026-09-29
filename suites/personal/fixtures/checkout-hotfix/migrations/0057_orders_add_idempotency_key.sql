-- checkout-api v3.9.0 sends an idempotency key with every submit so a retried request
-- cannot create a second order. Nullable: releases before v3.9.0 do not set it.
ALTER TABLE orders ADD COLUMN idempotency_key text;
CREATE UNIQUE INDEX CONCURRENTLY orders_idempotency_key_uniq
  ON orders (idempotency_key) WHERE idempotency_key IS NOT NULL;
