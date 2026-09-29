CREATE TABLE subscription_events (
    id               bigserial PRIMARY KEY,
    subscription_id  bigint NOT NULL REFERENCES subscriptions(id),
    actor            text NOT NULL,
    from_status      text,
    to_status        text NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX subscription_events_subscription_id_idx ON subscription_events (subscription_id);
