'use strict';
const {inputs,guardPath}=require('./assemble-controller');
const {verifyDeclaredArchiveClosure}=require('./archive-closure');
const {createHash}=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');

function check({writeInventory=false}={}) {
  const source=inputs();
  const files=source.map(({path,content})=>({path,content,kind:'file'}));
  const descriptors=[];
  for (const f of files.filter(f=>f.path.endsWith('.js'))) {
    for (const match of f.content.matchAll(/(?:require|import)\(['"]([^'"]+)['"]\)/g)) descriptors.push({from:f.path,specifier:match[1],kind:'static'});
  }
  const manifest={version:1,profile:'controller-source-archive',runtime:'nodejs24',entry:'controller-entry.js',rootPackage:'package.json',packageLock:'package-lock.json',files:files.map(f=>({path:f.path,sha256:createHash('sha256').update(f.content).digest('hex')}))};
  const sourceMap={version:1,profile:'controller-source-archive',paths:Object.fromEntries(source.map(f=>[f.path,f.source])),modes:Object.fromEntries(source.map(f=>[f.path,f.mode.toString(8).padStart(4,'0')]))};
  const lock=JSON.parse(files.find(f=>f.path==='package-lock.json').content);
  const result=verifyDeclaredArchiveClosure({manifest,files,importDescriptors:descriptors,lock});
  if (source.some(f=>![0o644,0o755].includes(f.mode))) result.errors.push('ARCHIVE_MODE_INVALID');
  const contracts={'archive-manifest.json':manifest,'declared-imports.json':descriptors,'archive-source-map.json':sourceMap};
  // Check never writes. Regeneration is an explicit, reviewable source-contract change.
  for (const name of Object.keys(contracts)) {
    const destination=path.join(root,'deployment',name);
    guardPath(destination,'ARCHIVE_INVENTORY_INVALID');
    const info=fs.lstatSync(destination,{throwIfNoEntry:false});
    if (info && !info.isFile()) throw Error('ARCHIVE_INVENTORY_INVALID');
  }
  const stale=[];
  for (const [name,value] of Object.entries(contracts)) {
    const destination=path.join(root,'deployment',name);
    if (writeInventory && !result.errors.length) fs.writeFileSync(destination,JSON.stringify(value,null,2)+'\n');
    else {
      try { if (JSON.stringify(JSON.parse(fs.readFileSync(destination,'utf8')))!==JSON.stringify(value)) stale.push(name); }
      catch (_) { stale.push(name); }
    }
  }
  if (stale.length) result.errors.push('ARCHIVE_INVENTORY_STALE');
  result.inventoryConsistent=stale.length===0;
  result.staleInventories=stale;
  result.ok=result.errors.length===0;
  return result;
}

module.exports={check};
if (require.main===module) {
  try {
    const args=process.argv.slice(2);
    if (args.length>1 || args.some(arg=>arg!=='--write-inventory')) throw Error('ARCHIVE_ARGUMENT_INVALID');
    const result=check({writeInventory:args.includes('--write-inventory')});
    console.log(JSON.stringify(result));if (!result.ok) process.exitCode=1;
  } catch (error) {
    console.log(JSON.stringify({ok:false,inventoryConsistent:false,errors:['ARCHIVE_INVENTORY_STALE',error.code || error.message]}));
    process.exitCode=1;
  }
}
