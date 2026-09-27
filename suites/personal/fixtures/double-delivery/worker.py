def initialize(conn):
    conn.executescript("""
    CREATE TABLE seen (delivery TEXT PRIMARY KEY);
    CREATE TABLE outbox (job TEXT NOT NULL, amount INTEGER NOT NULL);
    """)


def handle(conn, delivery):
    if conn.execute("SELECT 1 FROM seen WHERE delivery = ?", (delivery["delivery"],)).fetchone():
        return False
    conn.execute("INSERT INTO seen VALUES (?)", (delivery["delivery"],))
    amount = delivery["amount"]
    if not isinstance(amount, int):
        raise ValueError("amount must be an int")
    conn.execute("INSERT INTO outbox VALUES (?, ?)", (delivery["job"], amount))
    conn.commit()
    return True
