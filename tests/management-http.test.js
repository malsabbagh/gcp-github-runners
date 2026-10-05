'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createManagementHttpHandler} = require('../cloud-functions/webhook-handler/management-http');
const authority = {expectedAudience: 'https://management.example.invalid', adminSubject: 'admin-subject', schedulerSubject: 'scheduler-subject'};
const ownership = {key: 'a'.repeat(64), token: '11111111-1111-4111-8111-111111111111', name: 'fixture-worker',
  zone: 'us-central1-a', project: 'example-project', instanceId: '12345',
  instanceCreationTimestamp: '2026-10-05T10:00:00Z', claimId: '22222222-2222-4222-8222-222222222222'};
const admin = {verified: true, audience: authority.expectedAudience, subject: authority.adminSubject, role: 'admin'};
function fixture({enabled = true, principal = admin, authenticateInvocation} = {}) {
  const calls = []; let authenticationCalls = 0;
  const controller = Object.fromEntries(['requestDrain','prepareStop','dispatchIntent','retireAllocation','reconcileOrphan','recover','runScheduled']
    .map(method => [method, async input => {calls.push({method, input}); return {status: 'preserved', reason: 'private-provider-detail', token: 'must-not-echo'};} ]));
  const handler = createManagementHttpHandler({...authority, controller, enabled,
    authenticateInvocation: authenticateInvocation || (async () => {authenticationCalls++; return principal;})});
  async function invoke(operation = 'requestDrain', body = {request: ownership}, changes = {}) {
    const path = `/management/${operation}`;
    const req = {path, originalUrl: path, method: 'POST', is: type => type === 'application/json',
      rawBody: Buffer.from(JSON.stringify(body)), body: structuredClone(body), ...changes};
    const answer = {headers: {}};
    const res = {set(k,v) {answer.headers[k]=v; return this;}, status(value) {answer.status=value;return this;},
      json(value) {answer.body=value;return answer;}};
    await handler(req,res); return {answer,req};
  }
  return {invoke,calls,controller,authenticationCalls: () => authenticationCalls};
}
test('disabled endpoint rejects before authenticator or controller', async () => {
  const f = fixture({enabled:false}); const {answer}=await f.invoke();
  assert.equal(answer.status,503);assert.equal(f.authenticationCalls(),0);assert.equal(f.calls.length,0);
});
test('disabled endpoint needs no clients or invented authority configuration',async()=>{
  const handler=createManagementHttpHandler({});let answer;
  const res={set(){return this;},status(value){assert.equal(value,503);return this;},json(value){answer=value;}};
  await handler({},res);assert.deepEqual(answer,{ok:false,code:'MANAGEMENT_DISABLED'});
});
test('default authentication denies even caller-provided verified and forwarded claims', async () => {
  const f=fixture({authenticateInvocation:async()=>null});
  const {answer}=await f.invoke('requestDrain',{request:ownership},{verified:true, principal:admin,headers:{'x-forwarded-subject':authority.adminSubject}});
  assert.equal(answer.status,403);assert.equal(f.calls.length,0);
});
test('exact verifier audience subject role and verified boolean are mandatory', async () => {
  for (const patch of [{verified:'true'},{audience:'https://other.example.invalid'},{subject:'other'},{role:'worker'},{role:'scheduler'}]) {
    const f=fixture({principal:{...admin,...patch}}); assert.equal((await f.invoke()).answer.status,403);assert.equal(f.calls.length,0);
  }
});
test('fixed management routes delegate only exact ownership and fixed phases', async () => {
  const mapping={requestDrain:'requestDrain',prepareStop:'prepareStop',dispatchDrain:'dispatchIntent',dispatchStop:'dispatchIntent',
    retire:'retireAllocation',reconcileOrphan:'reconcileOrphan',recover:'recover'};
  for (const [operation,method] of Object.entries(mapping)) {
    const f=fixture();assert.equal((await f.invoke(operation)).answer.status,200);
    assert.deepEqual(f.calls,[{method,input:operation.startsWith('dispatch')?{...ownership,phase:operation==='dispatchDrain'?'drain':'stop'}:ownership}]);
  }
});
test('scheduler principal may recover and schedule but cannot dispatch or retire', async () => {
  const principal={verified:true,audience:authority.expectedAudience,subject:authority.schedulerSubject,role:'scheduler'};
  const f=fixture({principal});assert.equal((await f.invoke('recover')).answer.status,200);
  const scheduled=await f.invoke('scheduled',{});assert.equal(scheduled.answer.status,200);
  assert.equal(f.calls[1].method,'runScheduled');assert.equal(f.calls[1].input,scheduled.req);
  for (const op of ['requestDrain','prepareStop','dispatchDrain','dispatchStop','retire','reconcileOrphan'])
    assert.equal((await f.invoke(op)).answer.status,403);
  assert.equal(f.calls.length,2);
});
test('unknown route query method and content type cannot invoke controller', async () => {
  const f=fixture();
  for (const [op,change] of [['unknown',{}],['retire',{method:'GET'}],['retire',{originalUrl:'/management/retire?operation=recover'}],
    ['retire',{path:'/management/retire/',originalUrl:'/management/retire/'}],['retire',{is:()=>false}]])
    assert.equal((await f.invoke(op,{request:ownership},change)).answer.status,400);
  assert.equal(f.calls.length,0);
});
test('raw JSON must be bounded canonical valid UTF8 and match middleware body', async () => {
  const f=fixture();
  for (const changes of [{rawBody:Buffer.from('{')},{rawBody:Buffer.alloc(4097,32)},
    {rawBody:Buffer.from('{"request":null,"request":'+JSON.stringify(ownership)+'}')},
    {rawBody:Buffer.from(' '+JSON.stringify({request:ownership}))},{body:{request:{...ownership,instanceId:'999'}}},
    {rawBody:Buffer.from([0xff,0xff])}]) assert.equal((await f.invoke('retire',{request:ownership},changes)).answer.status,400);
  assert.equal(f.calls.length,0);
});
test('unknown body fields adapter options missing bindings and malformed ownership are denied', async () => {
  const f=fixture();
  for (const body of [{request:ownership,enabled:true},{request:{...ownership,adapter:'caller'}},{request:{...ownership,key:[ownership.key]}},
    {request:{...ownership,claimId:'invalid'}},{request:{...ownership,instanceCreationTimestamp:'invalid'}},{request:{...ownership,instanceId:12345}},{}])
    assert.equal((await f.invoke('retire',body)).answer.status,400);
  assert.equal((await f.invoke('scheduled',{request:ownership})).answer.status,400);assert.equal(f.calls.length,0);
});
test('response exposes fixed status only and never provider details or exceptions', async () => {
  const f=fixture();assert.deepEqual((await f.invoke()).answer.body,{ok:true,code:'MANAGEMENT_HANDLED',status:'preserved'});
  f.controller.requestDrain=async()=>{throw Error('private-provider-detail');};
  assert.deepEqual((await f.invoke()).answer.body,{ok:false,code:'MANAGEMENT_UNAVAILABLE'});
  f.controller.requestDrain=async()=>({status:'private-status',material:'secret'});
  assert.equal((await f.invoke()).answer.status,503);
});
test('repeat dispatch delegates identical binding without creating a new replay authority', async () => {
  const f=fixture();let dispatches=0;
  f.controller.dispatchIntent=async input=>{dispatches++;assert.deepEqual(input,{...ownership,phase:'drain'});return{status:'acknowledged',dispatchId:'private-detail'};};
  for(let i=0;i<2;i++)assert.deepEqual((await f.invoke('dispatchDrain')).answer.body,{ok:true,code:'MANAGEMENT_HANDLED',status:'acknowledged'});
  assert.equal(dispatches,2); // Canonical dispatcher owns durable intent replay/CAS; HTTP does not reset it.
});
