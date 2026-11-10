import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {writerURL,sessionURL,patchWriter,patchSession} from './preview-transform.mjs';

const preview=process.argv.includes('--preview');
assert.ok(process.argv.slice(2).every(arg=>arg==='--preview'),'Usage: node regression.mjs [--preview]');
const manifest=JSON.parse(readFileSync(new URL('./manifest.json',import.meta.url),'utf8'));
const hash=value=>createHash('sha256').update(value).digest('hex');
const lines=readFileSync(new URL('./fix.patch',import.meta.url),'utf8').split('\n');
assert.equal(lines.pop(),'','Patch must end with newline');
const sections=new Map();
let current;
for(let i=0;i<lines.length;i++){
 const line=lines[i];
 if(line.startsWith('--- a/')){
  const path=line.slice(6);
  assert.equal(lines[++i],'+++ b/'+path);
  assert.equal(sections.has(path),false,'Duplicate patch target');
  current=[];sections.set(path,current);
 }else if(line.startsWith('@@ ')){
  assert.ok(current,'Hunk without target');current.push([]);
 }else{
  assert.ok(current?.length,'Content without hunk');
  assert.ok([' ','+','-'].includes(line[0]),'Unsupported patch line');
  current.at(-1).push(line+'\n');
 }
}
assert.equal(sections.size,manifest.targets.length);
function applyExact(source,hunks,reverse=false){
 for(const hunk of reverse?[...hunks].reverse():hunks){
  const before=hunk.filter(line=>(reverse?' +':' -').includes(line[0])).map(line=>line.slice(1)).join('');
  const after=hunk.filter(line=>(reverse?' -':' +').includes(line[0])).map(line=>line.slice(1)).join('');
  assert.ok(before.length>0);
  assert.equal(source.split(before).length,2,'Exact hunk must match once');
  source=source.replace(before,after);
 }
 return source;
}
const seams={session:[sessionURL,patchSession],writer:[writerURL,patchWriter]};
const verified=[];
for(const target of manifest.targets){
 const [url,transform]=seams[target.name];
 assert.ok(sections.has(target.path),'Missing target diff');
 assert.equal(JSON.parse(readFileSync(new URL('../package.json',url),'utf8')).version,target.version);
 const source=readFileSync(new URL(url),'utf8');
 const digest=hash(source);
 const state=digest===target.originalSha256?'original':digest===target.patchedSha256?'patched':'unknown';
 assert.notEqual(state,'unknown','Installed source hash is not supported: '+target.name);
 if(preview)assert.equal(state,'original','Preview requires both original modules; use installed mode after deployment');
 const original=state==='original'?source:applyExact(source,sections.get(target.path),true);
 assert.equal(hash(original),target.originalSha256);
 const exact=applyExact(original,sections.get(target.path));
 assert.equal(hash(exact),target.patchedSha256,'Delivered patch output fingerprint');
 assert.equal(exact,transform(original),'Preview must equal the delivered production diff');
 assert.equal(exact.includes('ResearchHandle'),false,'Production diff must not export test constructor');
 verified.push({target:target.name,state});
}
console.log(JSON.stringify({verified,preview,syntheticOnly:true,childOldSpaceMiB:128}));
const runs=preview?[
 ['memory-case.mjs','baseline',1],['memory-case.mjs','candidate',0],
 ['memory-case.mjs','baseline',1],['memory-case.mjs','candidate',0],
 ['compatibility-case.mjs','baseline',0],['compatibility-case.mjs','candidate',0],
 ['compatibility-case.mjs','writer-only',0],['compatibility-case.mjs','session-only',0]
]:[['memory-case.mjs','installed',0],['compatibility-case.mjs','installed',0]];
const env={...process.env};delete env.NODE_OPTIONS;
for(const [file,variant,expected] of runs){
 const memory=file==='memory-case.mjs';
 const result=spawnSync(process.execPath,['--max-old-space-size=128',...(memory?['--expose-gc']:[]),file,variant],{
  cwd:new URL('.',import.meta.url),env,encoding:'utf8',timeout:15000,maxBuffer:1024*1024
 });
 assert.equal(result.error,undefined);
 assert.equal(result.signal,null);
 assert.equal(result.status,expected,result.stderr+'\n'+result.stdout);
 const data=JSON.parse(result.stdout.trim());
 console.log(JSON.stringify({test:file,variant,exitCode:result.status,...(memory?{payloadBytes:data.bytes,queuedDelta:data.queuedDelta,delayedDelta:data.delayedDelta}:{passed:data.passed})}));
}
console.log('PASS: exact delivered diff and all requested isolated cases verified; no installed files modified.');
