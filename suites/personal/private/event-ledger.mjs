import {fixture,preserved,observeCases,equal,check,toolChecks,pythonQuality} from './helpers.mjs';
const original=fixture('event-ledger');
export const reference={files:{...original,'ledger.py':"def initialize(conn):\n    conn.executescript(\"\"\"\n    CREATE TABLE events (tenant TEXT, event_id TEXT, amount INTEGER,\n                         PRIMARY KEY (tenant, event_id));\n    CREATE TABLE balances (tenant TEXT PRIMARY KEY, amount INTEGER NOT NULL);\n    \"\"\")\n\ndef apply_events(conn, events):\n    with conn:\n        for event in events:\n            tenant, event_id, amount = event[\"tenant\"], event[\"event_id\"], event[\"amount\"]\n            if not isinstance(tenant, str) or not tenant or not isinstance(event_id, str) or not event_id or type(amount) is not int:\n                raise ValueError(\"invalid event\")\n            old = conn.execute(\"SELECT amount FROM events WHERE tenant=? AND event_id=?\", (tenant, event_id)).fetchone()\n            if old is not None:\n                if old[0] != amount:\n                    raise ValueError(\"conflicting replay\")\n                continue\n            conn.execute(\"INSERT INTO events VALUES (?, ?, ?)\", (tenant, event_id, amount))\n            conn.execute(\"INSERT INTO balances VALUES (?, ?) ON CONFLICT(tenant) DO UPDATE SET amount = amount + excluded.amount\", (tenant, amount))\n"},answer:'Made batches atomic and replay-safe.'};
export const baseline={files:original,answer:'Duplicates are ignored by the unique key.'};
export async function grade({files,python,trace, lane, control, agent}) {
 const quality = await pythonQuality(python, files, 'ledger.py');
 const e=(tenant,event_id,amount) => ({tenant,event_id,amount});
 const red=e('red','a',7);
 const batches=[[red,red,e('blue','a',4)],[red,e('red','b',-2)],
 [e('red','c',5),e('red','a',9)],[e('red','d',6),e('red','bad',true)],[e('red','e',1),e('','bad',2)],[]];
 const r=await observeCases(python,batches);
 const events=[['blue','a',4],['red','a',7],['red','b',-2]];
 const balances=[['blue',4],['red',5]];
 const expected=[{events:events.slice(0,2),balances:[['blue',4],['red',7]],error:null},
 ...[null,'ValueError','ValueError','ValueError',null].map(error => ({events,balances,error}))];
 return [...quality,check('runs','correctness',r.ok,r.diagnostic),equal('replay-rollback-validation',r.value,expected),preserved(files,original,['ledger.py']),...toolChecks(trace,['ledger.py'],'check_public.py',false,{lane,control,agent})];
}
