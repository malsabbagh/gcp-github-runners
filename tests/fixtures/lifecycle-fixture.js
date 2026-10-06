'use strict';
const {identity}=require('../../cloud-functions/webhook-handler/job-identity');
const {knownReceipt,binding}=require('../../cloud-functions/cleanup-function/allocation-lifecycle');
function fixture({status='RUNNING',runnerAbsent=false}={}) {
  const event={repo_owner:'example-owner',repo_name:'example-repository',run_id:'10',job_id:'20',run_attempt:'1',labels:['self-hosted','private-one-job']};
  const {key,name}=identity(event),token='11111111-1111-4111-8111-111111111111',claimId='22222222-2222-4222-8222-222222222222';
  const bootstrap={version:1,state:'issued',claimId,runnerId:77,runnerName:name,runnerLabels:event.labels};
  const entry={name,token,zone:'us-central1-a',project:'example-project',instanceId:'12345',instanceCreationTimestamp:'2000-01-01T00:00:00Z',state:'active',demandDone:true,creationStarted:true,bootstrapExpiresAtMs:600000,workerServiceAccountEmail:'worker@example-project.iam.gserviceaccount.com',workerServiceAccountUniqueId:'123456789012345678901',bootstrap,runnerIdentity:{id:77,name,labels:event.labels}};
  const completion={verifiedWebhook:true,runnerId:77,runnerName:name,jobId:'20',runId:'10',runAttempt:'1',repositoryOwner:event.repo_owner,repositoryName:event.repo_name};
  const job={done:true,event:JSON.stringify(event),bootstrap:JSON.stringify(bootstrap),completion:JSON.stringify(completion)};
  const pool={entries:JSON.stringify({[key]:entry})};
  let vm={id:entry.instanceId,name,status,creationTimestamp:entry.instanceCreationTimestamp,zone:'https://www.googleapis.com/compute/v1/projects/example-project/zones/us-central1-a',selfLink:'https://www.googleapis.com/compute/v1/projects/example-project/zones/us-central1-a/instances/'+name,labels:{purpose:'github-runner'},metadata:{items:[{key:'allocation-key',value:key},{key:'reservation-token',value:token}]}};
  let runners=runnerAbsent?[]:[{id:77,name,busy:false,labels:event.labels.map(name=>({name}))}];
  let chain=Promise.resolve();const calls=[];
  const firestore={doc:name=>({name}),collection:name=>({doc:id=>({name:name+'/'+id})}),runTransaction:body=>{
    const pending=chain.then(async()=>{const writes=[];const value=await body({get:async ref=>({exists:true,data:()=>structuredClone(ref.name.startsWith('provisioning_pools/')?pool:job)}),set:(ref,data,opts)=>writes.push([ref,data,opts]),update:(ref,data)=>writes.push([ref,data,{merge:true}])});
      for(const [ref,data,opts] of writes){const target=ref.name.startsWith('provisioning_pools/')?pool:job;if(!opts?.merge)for(const k of Object.keys(target))delete target[k];Object.assign(target,structuredClone(data));}return value;});chain=pending.catch(()=>{});return pending;
  }};
  const compute={get:async()=>{calls.push('get');if(!vm)throw {code:5};return [structuredClone(vm)];},stop:async()=>{calls.push('stop');vm.status='TERMINATED';},delete:async()=>{calls.push('delete');vm=null;}};
  const runnerAdapter={listRunnerPage:async({page,perPage})=>({total_count:runners.length,runners:structuredClone(runners.slice((page-1)*perPage,page*perPage))}),inspectOwnedRunner:async()=>{const r=runners.find(r=>r.id===77);return r?{status:'present',busy:r.busy}:{status:'absent'};},deregisterOwnedRunner:async()=>{calls.push('deregister');runners=[];return {status:'absent'};}};
  const request={key,token,name,zone:entry.zone,project:entry.project,instanceId:entry.instanceId,instanceCreationTimestamp:entry.instanceCreationTimestamp,claimId};
  const getEntry=()=>JSON.parse(pool.entries)[key];
  function setEntry(next){pool.entries=JSON.stringify({[key]:next});}
  function acknowledgeLifecycle() {
    const e=getEntry(),bound=binding(key,e,knownReceipt({key,entry:e,job}));const lifecycle={};
    for(const phase of ['drain','stop']){const record={version:1,dispatchId:phase==='drain'?'33333333-3333-4333-8333-333333333333':'44444444-4444-4444-8444-444444444444',phase,binding:bound,evidenceSha256:'a'.repeat(64),state:'acknowledged',startedAtMs:1,observedAtMs:2};record.acknowledgement={version:1,dispatchId:record.dispatchId,phase,binding:bound,evidenceSha256:record.evidenceSha256,authenticated:true,incarnationFenced:true,state:phase==='drain'?'drained':'stopped'};lifecycle[phase]={version:1,state:'requested',binding:bound,actualCompletion:job.completion,sideEffectsEnabled:false,dispatch:record};}
    setEntry({...e,lifecycle});job.lifecycle=JSON.stringify(lifecycle);
  }
  return {event,key,name,entry,job,pool,firestore,compute,runnerAdapter,request,calls,getEntry,setEntry,acknowledgeLifecycle,setVm:next=>{vm=next;},getVm:()=>vm,setRunners:next=>{runners=next;}};
}
module.exports={fixture};
