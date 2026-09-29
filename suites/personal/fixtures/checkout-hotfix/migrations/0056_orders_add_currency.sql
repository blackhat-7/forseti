-- Orders carry their own currency so multi-currency carts can be reported on.
ALTER TABLE orders ADD COLUMN currency char(3) NOT NULL DEFAULT 'USD';
