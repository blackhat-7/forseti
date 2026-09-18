import {fixture,preserved,answerJson,jsonOnly,equal,toolChecks} from './helpers.mjs';
const original=fixture('source-map');
const expected={"routes": [{"method": "GET", "path": "/health", "auth": false, "success": 200}, {"method": "POST", "path": "/items", "auth": true, "success": 201}], "unknown_status": 404, "unauthorized_create_status": 401, "delete_implemented": false};
export const reference={files:original,answer:JSON.stringify(expected)};
export const baseline={files:original,answer:JSON.stringify({...expected,delete_implemented:true,unauthorized_create_status:201})};
export async function grade({answer,files,trace, lane, control, agent}) {
 return [equal('implemented-behavior-only',answerJson(answer),expected),jsonOnly(answer),preserved(files,original),...toolChecks(trace,['service.py'],null,true,{lane,control,agent})];
}
