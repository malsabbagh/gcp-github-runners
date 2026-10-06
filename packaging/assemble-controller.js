'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
function guardPath(full,code) {
  const resolved=path.resolve(full);
  if (!resolved.startsWith(root+path.sep)) throw Error(code);
  let current=root;
  for (const segment of path.relative(root,resolved).split(path.sep)) {
    current=path.join(current,segment);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw Error(code);
  }
}
const sha=text=>createHash('sha256').update(text).digest('hex');
// Assemble only reviewed runtime paths. Never copy .git, ambient configuration,
// tests, node_modules, state or credentials; reject symlinks at every leaf.
function inputs() {
  const mappings={'package.json':'deployment/deployment-package.json','package-lock.json':'deployment/deployment-package-lock.json','controller-entry.js':'controller-entry.js'};
  for (const dir of ['cloud-functions/webhook-handler','cloud-functions/cleanup-function']) {
    guardPath(path.join(root,dir),'ARCHIVE_FILE_INVALID');
    for (const name of fs.readdirSync(path.join(root,dir)).sort())
      if (name.endsWith('.js') && !name.endsWith('.test.js') && name!=='index.js') mappings[`${dir}/${name}`]=`${dir}/${name}`;
  }
  for (const p of ['cloud-functions/webhook-handler/provision-runner.py','cloud-functions/cleanup-function/runner-cleanup.sh']) mappings[p]=p;
  return Object.entries(mappings).sort(([a],[b])=>a.localeCompare(b)).map(([target,source])=> {
    const full=path.join(root,source);guardPath(full,'ARCHIVE_FILE_INVALID');const st=fs.lstatSync(full);
    if (!st.isFile() || st.isSymbolicLink()) throw Error('ARCHIVE_FILE_INVALID');
    return {path:target,source,content:fs.readFileSync(full,'utf8'),mode:st.mode&0o777};
  });
}
function assemble(destination) {
  const dir=path.resolve(destination);
  if (!dir.startsWith(root+path.sep) || dir===root || fs.existsSync(dir)) throw Error('ARCHIVE_DESTINATION_INVALID');
  guardPath(dir,'ARCHIVE_DESTINATION_INVALID');
  const files=inputs();fs.mkdirSync(dir,{recursive:true});guardPath(dir,'ARCHIVE_DESTINATION_INVALID');
  for (const file of files) {const target=path.join(dir,file.path);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,file.content,{mode:file.mode});}
  const manifest={version:1,profile:'controller-source-archive',runtime:'nodejs24',entry:'controller-entry.js',rootPackage:'package.json',packageLock:'package-lock.json',files:files.map(f=>({path:f.path,sha256:sha(f.content)}))};
  return {directory:dir,manifest,files};
}
function writeZip(result,archivePath,manifestPath) {
  guardPath(result.directory,'ARCHIVE_DESTINATION_INVALID');guardPath(path.resolve(archivePath),'ARCHIVE_DESTINATION_INVALID');guardPath(path.resolve(manifestPath),'ARCHIVE_DESTINATION_INVALID');
  return JSON.parse(execFileSync('python3',[path.join(__dirname,'controller-zip.py'),result.directory,archivePath,manifestPath],{encoding:'utf8',timeout:30000,stdio:['pipe','pipe','pipe']}));
}
if (require.main===module) {
  const result=assemble(process.argv[2] || path.join(root,'dist','controller'));
  const manifestPath=path.join(result.directory,'..','controller-manifest.json');
  fs.writeFileSync(manifestPath,JSON.stringify(result.manifest,null,2)+'\n');
  const receipt=writeZip(result,path.join(result.directory,'..','controller.zip'),manifestPath);
  console.log(`Prepared and inspected ${receipt.fileCount} runtime files in ${path.join(result.directory,'..','controller.zip')}; SHA256 ${receipt.archiveSha256}; no deployment performed.`);
}
module.exports={inputs,assemble,writeZip};
