'use strict';
const {inputs}=require('./assemble-controller');
const {verifyDeclaredArchiveClosure}=require('./archive-closure');
const {createHash}=require('node:crypto');
const fs=require('node:fs');
const files=inputs().map(({path,content})=>({path,content,kind:'file'}));
const descriptors=[];
for (const f of files.filter(f=>f.path.endsWith('.js'))) {
  for (const match of f.content.matchAll(/(?:require|import)\(['"]([^'"]+)['"]\)/g)) descriptors.push({from:f.path,specifier:match[1],kind:'static'});
}
const manifest={version:1,profile:'controller-source-archive',runtime:'nodejs24',entry:'controller-entry.js',rootPackage:'package.json',packageLock:'package-lock.json',files:files.map(f=>({path:f.path,sha256:createHash('sha256').update(f.content).digest('hex')}))};
const lock=JSON.parse(files.find(f=>f.path==='package-lock.json').content);
const result=verifyDeclaredArchiveClosure({manifest,files,importDescriptors:descriptors,lock});
if (process.argv.includes('--write-inventory')) {
  fs.writeFileSync('deployment/archive-manifest.json',JSON.stringify(manifest,null,2)+'\n');
  fs.writeFileSync('deployment/declared-imports.json',JSON.stringify(descriptors,null,2)+'\n');
}
console.log(JSON.stringify(result));if (!result.ok) process.exitCode=1;
