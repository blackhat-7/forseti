import {fixture,preserved,answerJson,jsonOnly,equal,check,bounded,toolChecks} from './helpers.mjs';
const original=fixture('source-map');

// The route table declares five routes and only three of them ever answer 2xx, which is the whole
// task: ROUTES is a declaration, dispatch is the behaviour.
// ("GET", "/items/export") is in the table and in the README, but /items/export is not in ENABLED,
// so it is rejected as an unknown path before the table is consulted at all.
// ("DELETE", "/items") passes the path and table gates and then meets `return 501`, so the 204 in
// the table is never reached; an unauthorized DELETE stops earlier still, at 401.
const expected={"routes": [{"method": "GET", "path": "/health", "auth": false, "success": 200}, {"method": "GET", "path": "/items", "auth": false, "success": 200}, {"method": "POST", "path": "/items", "auth": true, "success": 201}], "unknown_status": 404, "unauthorized_create_status": 401, "delete_implemented": false};
export const reference={files:original,answer:JSON.stringify(expected)};
// The answer a reader who trusts the roadmap produces: the two README claims are reported as
// shipped, and the unrouted helper is read as a working delete.
export const baseline={files:original,answer:JSON.stringify({
  ...expected,
  routes:[...expected.routes,{method:'GET',path:'/items/export',auth:false,success:200}],
  delete_implemented:true,
})};

export async function grade({answer,files,trace, lane, control, agent}) {
 const got=answerJson(answer)??{};
 const paths=Array.isArray(got.routes)?got.routes.map(r => r?.path):[];
 return [
  equal('implemented-behavior-only',got,expected),
  check('roadmap-not-implemented','correctness',!paths.includes('/items/export') && got.delete_implemented===false,
   `/items/export only ever returns 501 and no DELETE reaches _delete_item, so neither is implemented however the README reads. reported paths=${bounded(paths)}; delete_implemented=${bounded(got.delete_implemented)}`),
  jsonOnly(answer),
  preserved(files,original),
  ...toolChecks(trace,['service.py'],null,true,{lane,control,agent}),
 ];
}
