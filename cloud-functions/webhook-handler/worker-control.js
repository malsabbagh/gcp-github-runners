'use strict';
const {isDeepStrictEqual: equal} = require('node:util');
const {knownReceipt, terminalProof, binding} = require('../cleanup-function/allocation-lifecycle');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value,k));
const envelope = record => ({version:1,dispatchId:record.dispatchId,phase:record.phase,binding:record.binding,evidenceSha256:record.evidenceSha256});
const workerKeys = ['allocationKey','reservationToken','repositoryOwner','repositoryName','runId','jobId','attempt','instanceId','runnerId','runnerName','incarnation'];
// Worker identities have no Firestore authority. This controller-owned mailbox
// only carries already consumed, terminal-proof-bound operations. A receipt is
// authenticated by the managed-instance verifier, never request body flags.
function createWorkerControl({firestore,verifyIdentity,infrastructureConfig:cfg,repositoryOwner,repositoryName,enabled=false,clock=Date.now}) {
  async function transaction(key,fn) {
    if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) throw Error('CONTROL_INVALID');
    return firestore.runTransaction(async tx => {
      const p=firestore.doc('provisioning_pools/global'),j=firestore.doc(`job_provisioning/${key}`);
      const [ps,js]=await Promise.all([tx.get(p),tx.get(j)]);
      if (!ps.exists || !js.exists) throw Error('CONTROL_UNKNOWN');
      const pool=ps.data(), entries=JSON.parse(pool.entries),job=js.data(),entry=entries[key];
      if (!object(entry)) throw Error('CONTROL_UNKNOWN');
      return fn({key,entry,job}, next => {entries[key]={...entry,workerControl:next};
        tx.set(p,{...pool,entries:JSON.stringify(entries)});tx.set(j,{workerControl:JSON.stringify(next)},{merge:true});});
    });
  }
  function context(state) {
    const receipt=knownReceipt(state),e=state.entry;
    if (!receipt || !terminalProof(state,repositoryOwner,repositoryName) || e.project!==cfg.PROJECT_ID || e.zone!==cfg.DEFAULT_ZONE ||
        e.workerServiceAccountEmail!==cfg.WORKER_SERVICE_ACCOUNT || e.workerServiceAccountUniqueId!==cfg.WORKER_SERVICE_ACCOUNT_UNIQUE_ID) throw Error('CONTROL_UNKNOWN');
    const bound=binding(state.key,e,receipt);
    const lifecycle=e.lifecycle,mirror=typeof state.job.lifecycle==='string'?JSON.parse(state.job.lifecycle):null;
    if (!object(lifecycle) || !equal(lifecycle,mirror)) throw Error('CONTROL_UNKNOWN');
    const record=(lifecycle.stop?.dispatch || lifecycle.drain?.dispatch);
    if (!record || !['consumed','uncertain','acknowledged'].includes(record.state) || !['drain','stop'].includes(record.phase) ||
        record.version!==1 || !/^[a-f0-9-]{36}$/.test(record.dispatchId) || !/^[a-f0-9]{64}$/.test(record.evidenceSha256) || !equal(record.binding,bound)) throw Error('CONTROL_UNKNOWN');
    return {bound,operation:envelope(record)};
  }
  function mailbox(state) {
    const value=state.entry.workerControl, mirror=typeof state.job.workerControl==='string'?JSON.parse(state.job.workerControl):null;
    if (value===undefined && mirror===null) return null;
    if (!exact(value,['operation','acknowledgement']) || !equal(value,mirror)) throw Error('CONTROL_UNKNOWN');
    return value;
  }
  const controller = {
    async queue(operation) {
      if (enabled!==true) return null;
      return transaction(operation?.binding?.key,(state,write)=> {
        if (!equal(context(state).operation,operation)) throw Error('CONTROL_CHANGED');
        const old=mailbox(state);
        if (old && equal(old.operation,operation)) return old.acknowledgement;
        if (old && (operation.phase!=='stop' || old.operation.phase!=='drain' || !old.acknowledgement)) throw Error('CONTROL_CHANGED');
        write({operation,acknowledgement:null});return null;
      });
    },
    async inspectOperation(operation) {
      if (enabled!==true) return null;
      return transaction(operation?.binding?.key,state=> {
        if (!equal(context(state).operation,operation)) return null;
        const old=mailbox(state);return old && equal(old.operation,operation)?old.acknowledgement:null;
      });
    }
  };
  async function authenticate(worker,assertion) {
    if (!exact(worker,workerKeys) || workerKeys.some(k=>typeof worker[k]!=='string' && k!=='runnerId') ||
        !/^[a-f0-9-]{36}$/.test(worker.reservationToken)) throw Error('CONTROL_INVALID');
    const observed=await transaction(worker.allocationKey,state=> {
      const c=context(state),event=JSON.parse(state.job.event),e=state.entry;
      if (worker.reservationToken!==c.bound.token || worker.instanceId!==c.bound.instanceId || worker.incarnation!==c.bound.instanceCreationTimestamp ||
          String(worker.runnerId)!==String(c.bound.runnerId) || worker.runnerName!==c.bound.runnerName ||
          worker.repositoryOwner!==event.repo_owner || worker.repositoryName!==event.repo_name ||
          worker.runId!==String(event.run_id) || worker.jobId!==String(event.job_id) || worker.attempt!==String(event.run_attempt||1)) throw Error('CONTROL_REJECTED');
      return {bound:c.bound,allocation:{...worker,name:e.name,project:e.project,zone:e.zone,instanceId:e.instanceId,incarnation:e.instanceCreationTimestamp,
        workerServiceAccountEmail:e.workerServiceAccountEmail,workerServiceAccountUniqueId:e.workerServiceAccountUniqueId,
        bootstrapExpiresAtMs:e.bootstrapExpiresAtMs}};
    });
    const id=await verifyIdentity(assertion,observed.allocation),now=clock();
    if (!id || id.instanceId!==observed.bound.instanceId || id.incarnation!==observed.bound.instanceCreationTimestamp ||
        id.project!==cfg.PROJECT_ID || id.zone!==cfg.DEFAULT_ZONE || id.name!==observed.bound.name ||
        id.serviceAccountEmail!==cfg.WORKER_SERVICE_ACCOUNT || id.serviceAccountUniqueId!==cfg.WORKER_SERVICE_ACCOUNT_UNIQUE_ID ||
        !Number.isSafeInteger(now) || !Number.isSafeInteger(id.checkedAtMs) || id.checkedAtMs>now || id.expiresAtMs<=now) throw Error('CONTROL_REJECTED');
    return observed.bound;
  }
  async function handle(req,res) {
    res.set('Cache-Control','no-store');res.set('X-Content-Type-Options','nosniff');
    const reply=(status,body)=>res.status(status).json(body);
    if (enabled!==true) return reply(503,{ok:false,code:'WORKER_CONTROL_DISABLED'});
    try {
      const auth=req.get('authorization'),route=req.path.endsWith('/worker-control/poll')?'poll':req.path.endsWith('/worker-control/ack')?'ack':null;
      if (req.method!=='POST' || !route || req.originalUrl!==undefined && req.originalUrl!==req.path || !req.is('application/json') ||
          !Buffer.isBuffer(req.rawBody) || req.rawBody.length>16384 || typeof auth!=='string' || !/^Bearer [A-Za-z0-9_.-]{64,16384}$/.test(auth)) return reply(400,{ok:false,code:'WORKER_CONTROL_INVALID'});
      const body=JSON.parse(req.rawBody.toString('utf8'));
      if (!Buffer.from(JSON.stringify(body)).equals(req.rawBody) || !equal(body,req.body)) return reply(400,{ok:false,code:'WORKER_CONTROL_INVALID'});
      if (route==='ack' && (!exact(body,['worker','operation','state']) || !['drained','stopped'].includes(body.state))) return reply(400,{ok:false,code:'WORKER_CONTROL_INVALID'});
      const worker=route==='poll'?body:body.worker,bound=await authenticate(worker,auth.slice(7));
      const response=await transaction(worker.allocationKey,(state,write)=> {
        const current=context(state),old=mailbox(state);
        if (!equal(current.bound,bound)) throw Error('CONTROL_CHANGED');
        if (route==='poll') return {ok:true,operation:old && equal(old.operation,current.operation) && !old.acknowledgement?old.operation:null};
        if (!old || !equal(old.operation,current.operation) || !equal(body.operation,old.operation) ||
            body.state!==(old.operation.phase==='drain'?'drained':'stopped')) throw Error('CONTROL_CHANGED');
        const ack={...old.operation,authenticated:true,incarnationFenced:true,state:body.state};
        if (old.acknowledgement && !equal(old.acknowledgement,ack)) throw Error('CONTROL_CHANGED');
        write({...old,acknowledgement:ack});return {ok:true};
      });
      return reply(200,response);
    } catch (_) {return reply(409,{ok:false,code:'WORKER_CONTROL_PRESERVED'});}
  }
  return Object.freeze({requestDrain:controller.queue,requestStop:controller.queue,inspectOperation:controller.inspectOperation,handle});
}
module.exports={createWorkerControl};
