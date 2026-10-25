'use strict';
// Validate manifest ownership without loading SDKs, installing or using a provider.
const workspacePaths=['cloud-functions/webhook-handler','cloud-functions/cleanup-function'];
const object=value=>value!==null && typeof value==='object' && !Array.isArray(value);
const sameMap=(a,b)=>object(a)&&object(b)&&Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(k=>a[k]===b[k]);
const extraRuntime=p=>['optionalDependencies','peerDependencies','bundledDependencies','bundleDependencies'].some(k=>object(p)&&Object.hasOwn(p,k));
const runtime=p=>object(p)&&p.private===true&&p.type==='commonjs'&&p.main==='controller-entry.js'&&p.engines?.node==='24.x'&&!extraRuntime(p);
function verifyRuntimeDependencyContract(input) {
  const errors=new Set();
  if (!object(input)) return {ok:false,errors:['DEPENDENCY_INPUT_INVALID']};
  const {rootPackage,deploymentPackage,rootLock,deploymentLock,workspacePackages}=input;
  const canonical=rootPackage?.dependencies;
  if (!runtime(rootPackage)||!object(canonical)||!Object.keys(canonical).length||
      Object.entries(canonical).some(([name,version])=>!/^(@[a-z0-9_-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(name)||!/^\d+\.\d+\.\d+$/.test(version))) errors.add('DEPENDENCY_ROOT_INVALID');
  if (!runtime(deploymentPackage)||!sameMap(canonical,deploymentPackage.dependencies)) errors.add('DEPENDENCY_DEPLOYMENT_MISMATCH');
  for (const [label,lock,pkg] of [['ROOT',rootLock,rootPackage],['DEPLOYMENT',deploymentLock,deploymentPackage]]) {
    if (!object(lock)||lock.lockfileVersion!==3||!object(lock.packages)||
        !sameMap(lock.packages['']?.dependencies,pkg?.dependencies)||lock.packages['']?.engines?.node!=='24.x'||
        Object.entries(pkg?.dependencies||{}).some(([name,version])=>{
          const record=lock.packages?.['node_modules/'+name];
          return record?.version!==version||typeof record?.integrity!=='string'||!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(record.integrity);
        })) errors.add('DEPENDENCY_'+label+'_LOCK_MISMATCH');
  }
  if(object(canonical)&&Object.keys(canonical).some(name=>rootLock?.packages?.['node_modules/'+name]?.integrity!==deploymentLock?.packages?.['node_modules/'+name]?.integrity)) errors.add('DEPENDENCY_DIRECT_ARTIFACT_MISMATCH');
  if (!Array.isArray(rootPackage?.workspaces)||JSON.stringify([...rootPackage.workspaces].sort())!==JSON.stringify([...workspacePaths].sort())||
      !object(workspacePackages)||JSON.stringify(Object.keys(workspacePackages).sort())!==JSON.stringify([...workspacePaths].sort())) errors.add('DEPENDENCY_WORKSPACE_MISMATCH');
  else for (const name of workspacePaths) {
    const pkg=workspacePackages[name],locked=rootLock?.packages?.[name];
    if (!object(pkg)||pkg.private!==true||pkg.type!=='commonjs'||pkg.main!=='index.js'||pkg.engines?.node!=='24.x'||extraRuntime(pkg)||
        !object(pkg.dependencies)||Object.entries(pkg.dependencies).some(([key,value])=>canonical?.[key]!==value)||
        !sameMap(pkg.dependencies,locked?.dependencies)||locked?.engines?.node!=='24.x') errors.add('DEPENDENCY_WORKSPACE_MISMATCH');
  }
  return {ok:errors.size===0,canonicalManifest:'package.json',errors:[...errors].sort()};
}
function readRuntimeDependencyContract(root) {
  const fs=require('node:fs'),path=require('node:path');
  const read=name=>{
    let current=path.resolve(root);
    for(const part of ['',...name.split('/')]) {
      current=path.join(current,part);
      if(fs.lstatSync(current,{throwIfNoEntry:false})?.isSymbolicLink())throw Error('DEPENDENCY_INPUT_INVALID');
    }
    return JSON.parse(fs.readFileSync(current,'utf8'));
  };
  return {rootPackage:read('package.json'),deploymentPackage:read('deployment/deployment-package.json'),
    rootLock:read('package-lock.json'),deploymentLock:read('deployment/deployment-package-lock.json'),
    workspacePackages:Object.fromEntries(workspacePaths.map(name=>[name,read(name+'/package.json')]))};
}
module.exports={verifyRuntimeDependencyContract,readRuntimeDependencyContract};
if (require.main===module) {
  try {
    const result=verifyRuntimeDependencyContract(readRuntimeDependencyContract(require('node:path').resolve(__dirname,'..')));
    console.log(JSON.stringify(result));if(!result.ok)process.exitCode=1;
  } catch (_) {console.log(JSON.stringify({ok:false,errors:['DEPENDENCY_INPUT_INVALID']}));process.exitCode=1;}
}
