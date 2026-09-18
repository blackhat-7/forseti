import {fixture,preserved,answerJson,jsonOnly,equal,toolChecks} from './helpers.mjs';
const original=fixture('incident-window');
const expected={"status": "waiting_for_capacity", "retry_count": 3, "request_age_minutes": 25, "evidence_ids": ["e1", "e2", "e3"], "global_outage_proven": false};
export const reference={files:original,answer:JSON.stringify(expected)};
export const baseline={files:original,answer:JSON.stringify({status:'running',retry_count:4,request_age_minutes:20,evidence_ids:['e1','e2','e2','e3'],global_outage_proven:true})};
export async function grade({answer,files,trace, lane, control, agent}) {
 return [equal('incident-facts',answerJson(answer),expected),jsonOnly(answer),preserved(files,original),...toolChecks(trace,['events.jsonl'],null,true,{lane,control,agent})];
}
