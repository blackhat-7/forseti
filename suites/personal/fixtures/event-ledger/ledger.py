def initialize(conn):
    conn.executescript("""
    CREATE TABLE events (tenant TEXT, event_id TEXT, amount INTEGER,
                         PRIMARY KEY (tenant, event_id));
    CREATE TABLE balances (tenant TEXT PRIMARY KEY, amount INTEGER NOT NULL);
    """)

def apply_events(conn, events):
    for event in events:
        conn.execute("INSERT OR IGNORE INTO events VALUES (?, ?, ?)",
                     (event["tenant"], event["event_id"], event["amount"]))
        conn.execute("INSERT INTO balances VALUES (?, ?) ON CONFLICT(tenant) "
                     "DO UPDATE SET amount = amount + excluded.amount",
                     (event["tenant"], event["amount"]))
    conn.commit()
