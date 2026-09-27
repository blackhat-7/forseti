import {fixture,preserved,observeCases,equal,check,toolChecks,pythonHygiene} from './helpers.mjs';
const original=fixture('event-ledger');
export const reference={files:{...original,'ledger.py':"def initialize(conn):\n    conn.executescript(\"\"\"\n    CREATE TABLE events (tenant TEXT, event_id TEXT, amount INTEGER,\n                         PRIMARY KEY (tenant, event_id));\n    CREATE TABLE balances (tenant TEXT PRIMARY KEY, amount INTEGER NOT NULL);\n    \"\"\")\n\ndef apply_events(conn, events):\n    with conn:\n        for event in events:\n            tenant, event_id, amount = event[\"tenant\"], event[\"event_id\"], event[\"amount\"]\n            if not isinstance(tenant, str) or not tenant or not isinstance(event_id, str) or not event_id or type(amount) is not int:\n                raise ValueError(\"invalid event\")\n            old = conn.execute(\"SELECT amount FROM events WHERE tenant=? AND event_id=?\", (tenant, event_id)).fetchone()\n            if old is not None:\n                if old[0] != amount:\n                    raise ValueError(\"conflicting replay\")\n                continue\n            conn.execute(\"INSERT INTO events VALUES (?, ?, ?)\", (tenant, event_id, amount))\n            conn.execute(\"INSERT INTO balances VALUES (?, ?) ON CONFLICT(tenant) DO UPDATE SET amount = amount + excluded.amount\", (tenant, amount))\n"},answer:'Made batches atomic and replay-safe.'};
export const baseline={files:original,answer:'Duplicates are ignored by the unique key.'};
export async function grade({files,python,trace, lane, control, agent}) {
 const hygiene = await pythonHygiene(python, files, 'ledger.py');
 const e=(tenant,event_id,amount) => ({tenant,event_id,amount});
 const red=e('red','a',7);
 const batches=[[red,red,e('blue','a',4)],[red,e('red','b',-2)],
 [e('red','c',5),e('red','a',9)],[e('red','d',6),e('red','bad',true)],[e('red','e',1),e('','bad',2)],[]];
 const r=await observeCases(python,batches);
 const events=[['blue','a',4],['red','a',7],['red','b',-2]];
 const balances=[['blue',4],['red',5]];
 const expected=[{events:events.slice(0,2),balances:[['blue',4],['red',7]],error:null},
 ...[null,'ValueError','ValueError','ValueError',null].map(error => ({events,balances,error}))];
 return [...hygiene,check('runs','correctness',r.ok,r.diagnostic),equal('replay-rollback-validation',r.value,expected),preserved(files,original,['ledger.py']),...toolChecks(trace,['ledger.py'],'check_public.py',false,{lane,control,agent})];
}

export const review = {
  anchor: {'ledger.py': reference.files['ledger.py']},
  paths: ['ledger.py'],
  items: [
    {id:'validation-duplicated', ask:'Is the event validation — the tenant and event_id string tests and the int-not-bool amount test — spelled out in more than one place, so a rule change would mean editing it more than once? One helper called twice is not duplication.'},
    {id:'unearned-abstraction', ask:'Does the submission add a class, registry, strategy table, config option, decorator or wrapper layer that has only one real use here and could be a plain function or a literal?'},
    {id:'dead-code', ask:'Is there unused or unreachable code left behind: a function nothing calls, an unused constant or import, a value computed and then thrown away, or a commented-out block?'},
    {id:'explanatory-noise', ask:'Are there comments or docstrings that only restate what the adjacent line already says, rather than recording a reason the code cannot express?'},
  ],
};
