CREATE TABLE shipment (
  id              INTEGER PRIMARY KEY,
  weight_kg       REAL    NOT NULL CHECK (weight_kg > 0),
  destination     TEXT    NOT NULL CHECK (destination IN ('domestic', 'international')),
  insured_value   INTEGER NOT NULL CHECK (insured_value >= 0),
  express         INTEGER NOT NULL CHECK (express IN (0, 1))
);
