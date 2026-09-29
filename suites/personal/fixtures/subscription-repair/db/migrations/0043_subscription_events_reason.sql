ALTER TABLE subscription_events ADD COLUMN reason text;
CREATE INDEX subscription_events_created_at_idx ON subscription_events (created_at);
