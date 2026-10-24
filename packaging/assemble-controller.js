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
    if (fs.lstatSync(current,{throwIfNoEntry:false})?.isSymbolicLink()) throw Error(code);
  }
}
const sha=text=>createHash('sha256').update(text).digest('hex');
// Assemble only reviewed runtime paths. Never copy .git, ambient configuration,
// tests, node_modules, state or credentials; reject symlinks at every leaf.
function inputs() {
  const mappings={'LICENSE':'LICENSE','NOTICE.md':'NOTICE.md','package.json':'deployment/deployment-package.json','package-lock.json':'deployment/deployment-package-lock.json','controller-entry.js':'controller-entry.js'};
  for (const dir of ['cloud-functions/webhook-handler','cloud-functions/cleanup-function']) {
    guardPath(path.join(root,dir),'ARCHIVE_FILE_INVALID');
    for (const name of fs.readdirSync(path.join(root,dir)).sort())
      if (name.endsWith('.js') && !name.endsWith('.test.js') && name!=='index.js') mappings[`${dir}/${name}`]=`${dir}/${name}`;
  }
  for (const p of ['cloud-functions/webhook-handler/provision-runner.py','cloud-functions/cleanup-function/runner-cleanup.sh']) mappings[p]=p;
  return Object.entries(mappings).sort(([a],[b])=>a.localeCompare(b)).map(([target,source])=> {
    const full=path.join(root,source);guardPath(full,'ARCHIVE_FILE_INVALID');const st=fs.lstatSync(full);
    if (!st.isFile() || st.isSymbolicLink()) throw Error('ARCHIVE_FILE_INVALID');
    return {path:target,source,content:fs.readFileSync(full,'utf8'),mode:st.mode&0o7777};
  });
}
function assemble(destination) {
  const dir=path.resolve(destination);
  if (!dir.startsWith(root+path.sep) || dir===root || fs.existsSync(dir)) throw Error('ARCHIVE_DESTINATION_INVALID');
  guardPath(dir,'ARCHIVE_DESTINATION_INVALID');
  const files=inputs();fs.mkdirSync(dir,{recursive:true});guardPath(dir,'ARCHIVE_DESTINATION_INVALID');
  for (const file of files) {const target=path.join(dir,file.path);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,file.content,{mode:file.mode,flag:'wx'});fs.chmodSync(target,file.mode);}
  const manifest={version:1,profile:'controller-source-archive',runtime:'nodejs24',entry:'controller-entry.js',rootPackage:'package.json',packageLock:'package-lock.json',files:files.map(f=>({path:f.path,sha256:sha(f.content)}))};
  return {directory:dir,manifest,files};
}
function writeZip(result,archivePath,manifestPath) {
  guardPath(result.directory,'ARCHIVE_DESTINATION_INVALID');guardPath(path.resolve(archivePath),'ARCHIVE_DESTINATION_INVALID');guardPath(path.resolve(manifestPath),'ARCHIVE_DESTINATION_INVALID');
  const argv=['python3',path.join(__dirname,'controller-zip.py'),result.directory,archivePath,manifestPath,path.join(root,'deployment/archive-source-map.json')];
  return {...JSON.parse(execFileSync(argv[0],argv.slice(1),{encoding:'utf8',timeout:30000,stdio:['pipe','pipe','pipe']})),argv};
}
function packageController(destination=path.join(root,'dist','controller')) {
  const startedAt=new Date().toISOString();
  const dir=path.resolve(destination);
  const manifestPath=path.join(dir,'..','controller-manifest.json');
  const archive=path.join(dir,'..','controller.zip');
  const receiptPath=path.join(dir,'..','controller-receipt.json');
  for (const target of [dir,manifestPath,archive,receiptPath]) {
    guardPath(target,'ARCHIVE_DESTINATION_INVALID');
    if (fs.existsSync(target)) throw Error('ARCHIVE_DESTINATION_INVALID');
  }
  const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim();
  if (git('status','--porcelain','--untracked-files=normal')) throw Error('ARCHIVE_REVISION_DIRTY');
  const revision={commit:git('rev-parse','HEAD'),tree:git('rev-parse','HEAD^{tree}')};
  const checkArgv=[process.execPath,path.join(__dirname,'check-controller.js')];
  const checked=JSON.parse(execFileSync(checkArgv[0],checkArgv.slice(1),{encoding:'utf8',cwd:root}));
  if (!checked.ok) throw Error('ARCHIVE_INVENTORY_STALE');
  const toolFiles=['packaging/assemble-controller.js','packaging/check-controller.js','packaging/archive-closure.js','packaging/controller-zip.py'];
  const lockFiles=['package-lock.json','deployment/deployment-package-lock.json','source-compatible/templates/package-lock.json','source-compatible/templates/cloud-functions/hybrid-cleanup-handler/package-lock.json','terraform/.terraform.lock.hcl'];
  const inventoryFiles=['deployment/archive-manifest.json','deployment/declared-imports.json','deployment/archive-source-map.json'];
  const selected=inputs();
  const bindingFiles=[...new Set([...selected.map(f=>f.source),...toolFiles,...lockFiles,...inventoryFiles])].sort();
  const committed=new Map(git('ls-tree','-r','--full-tree',revision.commit).split('\n').map(line=>{
    const [metadata,name]=line.split('\t');return [name,metadata.split(' ')[0]];
  }));
  function snapshot() {
    return Object.fromEntries(bindingFiles.map(name=>{
      const full=path.join(root,name);guardPath(full,'ARCHIVE_REVISION_INPUT_MISMATCH');
      const info=fs.lstatSync(full),mode=info.mode&0o7777;
      const data=fs.readFileSync(full);
      if (!info.isFile() || !['100644','100755'].includes(committed.get(name)) ||
          mode!==parseInt(committed.get(name).slice(-3),8) ||
          sha(data)!==sha(execFileSync('git',['-C',root,'show',revision.commit+':'+name]))) throw Error('ARCHIVE_REVISION_INPUT_MISMATCH');
      return [name,{sha256:sha(data),mode:mode.toString(8).padStart(4,'0')}];
    }));
  }
  const sourceSnapshot=snapshot();
  const result=assemble(dir);
  if (result.files.length!==selected.length || result.files.some(f=>!sourceSnapshot[f.source] ||
      sha(f.content)!==sourceSnapshot[f.source].sha256 || f.mode.toString(8).padStart(4,'0')!==sourceSnapshot[f.source].mode)) throw Error('ARCHIVE_REVISION_INPUT_MISMATCH');
  fs.writeFileSync(manifestPath,JSON.stringify(result.manifest,null,2)+'\n',{flag:'wx',mode:0o600});
  const zip=writeZip(result,archive,manifestPath);
  const hashes=names=>Object.fromEntries(names.map(name=>[name,sha(fs.readFileSync(path.join(root,name)))]));
  const receipt={version:1,scope:'local-controller-packaging-only',revision,startedAt,
    tools:{node:process.version,python:execFileSync('python3',['--version'],{encoding:'utf8'}).trim(),npm:execFileSync('npm',['--version'],{encoding:'utf8'}).trim()},
    toolSourceSha256:hashes(toolFiles),lockSha256:hashes(lockFiles),inventorySha256:hashes(inventoryFiles),
    sourceInputs:sourceSnapshot,
    archive:{sha256:zip.archiveSha256,fileCount:zip.fileCount,manifestSha256:sha(fs.readFileSync(manifestPath))},
    commands:[{argv:checkArgv,exitCode:0,result:checked},
      {argv:zip.argv,exitCode:0,result:zip}],
    qualification:{fullSourceSuiteRun:false,syntheticOrLocalOnly:true,providerCalls:false,cloudDeployed:false,liveReadiness:false}};
  const owned=new Set([...result.files.map(f=>path.relative(root,path.join(dir,f.path))),path.relative(root,manifestPath),path.relative(root,archive)]);
  const changes=git('status','--porcelain=v1','-z','--untracked-files=all').split('\0').filter(Boolean);
  if (changes.some(row=>!row.startsWith('?? ') || !owned.has(row.slice(3))) || git('rev-parse','HEAD')!==revision.commit ||
      JSON.stringify(snapshot())!==JSON.stringify(sourceSnapshot)) throw Error('ARCHIVE_REVISION_CHANGED');
  receipt.completedAt=new Date().toISOString();
  fs.writeFileSync(receiptPath,JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});
  return {archive,receiptPath,receipt};
}
module.exports={inputs,assemble,writeZip,guardPath,packageController};
if (require.main===module) {
  const result=packageController(process.argv[2]);
  console.log(`Prepared and inspected ${result.receipt.archive.fileCount} runtime files in ${result.archive}; SHA256 ${result.receipt.archive.sha256}; packaging-only receipt ${result.receiptPath}; no deployment performed.`);
}
