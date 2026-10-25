'use strict';
// Offline lock facts only. Advisory judgments and dated observations live separately.
const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const root=path.resolve(__dirname,'..');
const lockProfiles=[
  ['package-lock.json','maintainer-and-runtime'],
  ['deployment/deployment-package-lock.json','standalone-production'],
  ['source-compatible/templates/package-lock.json','reference-only'],
  ['source-compatible/templates/cloud-functions/hybrid-cleanup-handler/package-lock.json','reference-only'],
];
const relevant=new Set(['uuid','body-parser','fast-uri','form-data','@tootallnate/once','once']);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function packageName(location,record) {
  return record.name||location.split('node_modules/').at(-1)||'<root>';
}
function resolveDependency(packages,owner,name) {
  let current=owner;
  for (;;) {
    const candidate=(current?current+'/':'')+'node_modules/'+name;
    const record=packages[candidate];
    if (record) {
      if (!record.link) return candidate;
      if (typeof record.resolved!=='string'||!packages[record.resolved]||packages[record.resolved].link) throw Error('DEPENDENCY_GRAPH_INVALID_LINK');
      return record.resolved;
    }
    if (!current) return null;
    const parent=path.posix.dirname(current);current=parent==='.'?'':parent;
  }
}
function inventoryLock(lock,role) {
  if (!object(lock)||lock.lockfileVersion!==3||!object(lock.packages)||!object(lock.packages[''])||Object.keys(lock.packages).length>10000) throw Error('DEPENDENCY_GRAPH_INVALID');
  const packages=lock.packages,edges=[];
  for (const [location,record] of Object.entries(packages)) {
    if (!object(record)||location&&(location.startsWith('/')||location.includes('\\')||location.split('/').some(p=>!p||p==='.'||p==='..'))) throw Error('DEPENDENCY_GRAPH_INVALID');
    if (record.link) continue;
    for (const [field,kind] of [['dependencies','runtime'],['optionalDependencies','optional'],['peerDependencies','peer']]) {
      for (const [name,requested] of Object.entries(record[field]||{})) {
        if (field==='dependencies'&&Object.hasOwn(record.optionalDependencies||{},name)) continue;
        const target=resolveDependency(packages,location,name);
        if (!target) {
          if (kind==='runtime') throw Error('DEPENDENCY_GRAPH_MISSING_EDGE');
          continue; // An absent optional/peer package is not a locked occurrence.
        }
        edges.push({from:location,to:target,name,requested,kind});
      }
    }
  }
  const outgoing=new Map(),incoming=new Map();
  for (const edge of edges) {
    if (!outgoing.has(edge.from)) outgoing.set(edge.from,[]);
    if (!incoming.has(edge.to)) incoming.set(edge.to,[]);
    outgoing.get(edge.from).push(edge);incoming.get(edge.to).push(edge);
  }
  const paths=new Map(),queue=[];
  const reference=role==='reference-only';
  const roots=Object.entries(packages).filter(([key,value])=>!value.link&&(key===''||!key.split('/').includes('node_modules')));
  const label=location=>packageName(location,packages[location])+'@'+packages[location].version;
  function enqueue(location,context,chain) {
    const key=context+'\0'+location;
    if (paths.has(key)) return;
    paths.set(key,chain);queue.push({location,context,chain});
  }
  const direct=[];
  for (const [location,record] of roots.sort(([a],[b])=>a.localeCompare(b))) {
    for (const [field,kind] of [['dependencies','runtime'],['optionalDependencies','optional'],['peerDependencies','peer'],['devDependencies','tooling']]) {
      const context=reference?'reference-'+(kind==='tooling'?'tooling':'runtime'):kind==='tooling'?'tooling':location?'workspace-compatibility':'production';
      for (const [name,requested] of Object.entries(record[field]||{}).sort(([a],[b])=>a.localeCompare(b))) {
        if(field==='dependencies'&&Object.hasOwn(record.optionalDependencies||{},name))continue;
        const target=resolveDependency(packages,location,name);
        if (!target) {if(kind==='optional'||kind==='peer')continue;throw Error('DEPENDENCY_GRAPH_MISSING_ROOT');}
        const chain=location?[label(location),label(target)]:[label(target)];
        enqueue(target,context,chain);
        if (kind!=='tooling') direct.push({from:location||'<root>',name,requested,kind,location:target,version:packages[target].version,context});
      }
    }
  }
  for (let n=0;n<queue.length;n++) {
    const {location,context,chain}=queue[n];
    for (const edge of outgoing.get(location)||[]) enqueue(edge.to,context,[...chain,label(edge.to)]);
  }
  const contexts=['production','tooling','workspace-compatibility','reference-runtime','reference-tooling'];
  const occurrences=Object.entries(packages).filter(([location,record])=>!record.link&&relevant.has(packageName(location,record)))
    .sort(([a],[b])=>a.localeCompare(b)).map(([location,record])=>({
      package:packageName(location,record),version:record.version,location,
      reachability:contexts.filter(context=>paths.has(context+'\0'+location)),
      representativePaths:Object.fromEntries(contexts.filter(context=>paths.has(context+'\0'+location)).map(context=>[context,paths.get(context+'\0'+location)])),
      owners:(incoming.get(location)||[]).map(edge=>({package:packageName(edge.from,packages[edge.from]),version:packages[edge.from].version,
        location:edge.from||'<root>',kind:edge.kind,requested:edge.requested})).sort((a,b)=>a.location.localeCompare(b.location)||a.kind.localeCompare(b.kind)),
    }));
  return {role,directRuntimeDeclarations:direct,occurrences};
}
function buildInventory(directory=root) {
  return {schemaVersion:1,scope:'locked-source-facts-not-execution-or-advisory-clearance',locks:lockProfiles.map(([name,role])=>{
    guard(directory,name);
    const bytes=fs.readFileSync(path.join(directory,name));
    return {path:name,sha256:createHash('sha256').update(bytes).digest('hex'),...inventoryLock(JSON.parse(bytes),role)};
  })};
}
function guard(directory,name) {
  let current=path.resolve(directory);
  for(const part of ['',...name.split('/')]) {
    current=path.join(current,part);
    const info=fs.lstatSync(current,{throwIfNoEntry:false});
    if(info?.isSymbolicLink())throw Error('DEPENDENCY_INVENTORY_PATH_INVALID');
  }
}
module.exports={resolveDependency,inventoryLock,buildInventory};
if (require.main===module) {
  try {
    const args=process.argv.slice(2);if(args.length!==1||!['--check','--write'].includes(args[0]))throw Error('DEPENDENCY_INVENTORY_ARGUMENT_INVALID');
    const output=path.join(root,'deployment/dependency-inventory.json');
    guard(root,'deployment/dependency-inventory.json');
    const existing=fs.lstatSync(output,{throwIfNoEntry:false});
    if(existing&&!existing.isFile())throw Error('DEPENDENCY_INVENTORY_DESTINATION_INVALID');
    const data=buildInventory();
    if(args[0]==='--write')fs.writeFileSync(output,JSON.stringify(data,null,2)+'\n');
    else {
      if(JSON.stringify(JSON.parse(fs.readFileSync(output,'utf8')))!==JSON.stringify(data))throw Error('DEPENDENCY_INVENTORY_STALE');
      guard(root,'deployment/dependency-status.json');
      const assessment=JSON.parse(fs.readFileSync(path.join(root,'deployment/dependency-status.json'),'utf8'));
      const hashes=Object.fromEntries(data.locks.map(lock=>[lock.path,lock.sha256]));
      if(JSON.stringify(assessment.lockSha256)!==JSON.stringify(hashes))throw Error('DEPENDENCY_ASSESSMENT_STALE');
    }
    console.log(JSON.stringify({ok:true,locks:data.locks.length}));
  } catch(error) {console.error(error.message);process.exitCode=1;}
}
