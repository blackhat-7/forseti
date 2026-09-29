CREATE TABLE charges (
    id                 bigserial PRIMARY KEY,
    account_id         bigint NOT NULL REFERENCES accounts(id),
    subscription_id    bigint NOT NULL REFERENCES subscriptions(id),
    amount_cents       integer NOT NULL,
    currency           text NOT NULL DEFAULT 'usd',
    status             text NOT NULL CONSTRAINT charges_status_check
                       CHECK (status IN ('succeeded', 'failed', 'refunded')),
    provider_charge_id text,
    failure_code       text,
    period_start       timestamptz,
    period_end         timestamptz,
    created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX charges_subscription_id_idx ON charges (subscription_id);
CREATE INDEX charges_created_at_idx ON charges (created_at);
