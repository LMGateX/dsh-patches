import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {writerURL,sessionURL,valuesURL,patchWriter,patchSession} from './preview-transform.mjs';
const candidate=['candidate','installed'].includes(process.argv[2]);
const hook=registerHooks({load(url,context,nextLoad){const loaded=nextLoad(url,context);if(url!==writerURL&&url!==sessionURL)return loaded;let source=String(loaded.source);if(process.argv[2]==='candidate'||(process.argv[2]==='writer-only'&&url===writerURL)||(process.argv[2]==='session-only'&&url===sessionURL))source=url===writerURL?patchWriter(source):patchSession(source);if(url===writerURL)source+='\nexport {JsonlSessionHandle as ResearchHandle};\n';return {...loaded,source};}});
const {ResearchHandle}=await import(writerURL);
const {Session,appendPluginRecord}=await import(sessionURL);
hook.deregister();
const {deepFreeze} = await import(valuesURL);
const originalClone = globalThis.structuredClone;
let cloneCalls = 0;
globalThis.structuredClone = (...args) => {cloneCalls++; return originalClone(...args);};
const event = (data,seq=0) => ({type:'research/event',seq,time:1,data});
const results=[];
function make(storageOverrides={}) {
 const lines=[];
 const storage={async persistBatch(header,batch) {for(const e of batch) lines.push(JSON.stringify(e));},releaseHandle(){},...storageOverrides};
 const h=new ResearchHandle(storage,'synthetic',{id:'synthetic'},'write',{cursor:0,materialized:false,inheritedEventCount:0},{async release(){}});
 return {h,lines};
}
async function success(name, input, expected, mutate=()=>{}, fast=false) {
 const {h,lines}=make(); const before=cloneCalls;
 h.enqueueLive(input,error=>{throw error;}); mutate(input); await h.drainLive(); await h.close();
 assert.deepEqual(lines.map(JSON.parse),[event(expected)]);
 assert.equal(cloneCalls-before,1,name+' clone path'); results.push(name);
}
async function invalid(name,input,check=()=>{}) {
 const {h}=make(); const before=cloneCalls;
 h.enqueueLive(input,error=>{throw error;}); check(h.buffered[0]);
 await assert.rejects(h.drainLive(),TypeError);
 assert.equal(h.buffered.length,1); assert.equal(h.drainPaused,true);
 assert.equal(cloneCalls-before,1); // keep invalid timing at drain, not enqueue
 h.buffered.length=0; await h.close(); results.push(name);
}
await success('mutable nested object and array ownership',event({object:{n:1},array:[{s:'before'}]}),{object:{n:1},array:[{s:'before'}]},e=>{e.data.object.n=9;e.data.array[0].s='after';e.data.array.push('extra');});
await success('shallow frozen root is not enough',Object.freeze(event({object:{n:1},array:[1]})),{object:{n:1},array:[1]},e=>{e.data.object.n=9;e.data.array[0]=7;});
await success('unmarked fully frozen JSON retains clone fallback',deepFreeze(event({array:[null,true,3,'flat'],object:{n:1}})),{array:[null,true,3,'flat'],object:{n:1}},()=>{},true);
{
 const {Session}=await import(sessionURL);
 const live=Session.create('synthetic').append('session/end-seed',{});
 assert.ok(Object.isFrozen(live));assert.ok(Object.isFrozen(live.data));
 const {h,lines}=make();const before=cloneCalls;h.enqueueLive(live,()=>{});
 assert.equal(h.buffered[0]===live,candidate);await h.drainLive();await h.close();
 assert.deepEqual(lines.map(JSON.parse),[JSON.parse(JSON.stringify(live))]);assert.equal(cloneCalls-before,candidate?0:1);results.push('actual Session.append provenance fast path');
}
await invalid('undefined remains enqueue-valid drain-invalid',deepFreeze(event({bad:undefined})),e=>assert.ok(Object.hasOwn(e.data,'bad')));
await invalid('negative zero preserved until drain',deepFreeze(event({bad:-0})),e=>assert.ok(Object.is(e.data.bad,-0)));
await invalid('Date remains Date until rejected by drain',deepFreeze(event({bad:new Date(0)})),e=>assert.ok(e.data.bad instanceof Date));
for(const [name,value] of [['NaN',NaN],['Infinity',Infinity],['BigInt',1n]]) await invalid(name+' fallback drain rejection',deepFreeze(event({bad:value})));
for(const [name,value] of [['function',()=>{}],['symbol value',Symbol('v')]]) {const {h}=make();assert.throws(()=>h.enqueueLive(deepFreeze(event({bad:value})),()=>{}),{name:'DataCloneError'});await h.close();results.push(name+' enqueue rejection');}
const ownProto=JSON.parse('{"__proto__":{"safe":1},"constructor":"value"}');await success('own __proto__ data safe',deepFreeze(event(ownProto)),JSON.parse('{"__proto__":{"safe":1},"constructor":"value"}'),()=>{},true);
let reads=0; const accessor={};Object.defineProperty(accessor,'x',{enumerable:true,get(){reads++;return 'once';}});
await success('frozen accessor read exactly once',Object.freeze(event(Object.freeze(accessor))),{x:'once'});assert.equal(reads,1);
reads=0; const late={};Object.defineProperty(late,'first',{enumerable:true,get(){reads++;return reads;}});late.bad=undefined;
await invalid('late-invalid accessor no duplicate getter',Object.freeze(event(Object.freeze(late))),e=>assert.equal(e.data.first,1));assert.equal(reads,1);
const sym=Symbol('ignored');await success('symbol keys dropped as structuredClone does',deepFreeze(event({x:1,[sym]:2})),{x:1});
const hidden={x:1};Object.defineProperty(hidden,'hidden',{value:2});await success('nonenumerable keys dropped',deepFreeze(event(hidden)),{x:1});
await invalid('sparse frozen array remains drain-invalid',deepFreeze(event({a:[,1]})));
const shared=Object.freeze({x:1});await success('DAG fallback preserved and JSON readback',deepFreeze(event({a:shared,b:shared})),{a:{x:1},b:{x:1}});
const cyclic={};cyclic.self=cyclic;await invalid('cycle clone then drain rejection',deepFreeze(event(cyclic)),e=>assert.equal(e.data.self,e.data));
await success('null prototype fallback',deepFreeze(event(Object.assign(Object.create(null),{x:1}))),{x:1});
await success('cross realm fallback',Object.freeze(event(vm.runInNewContext('Object.freeze({x:1})'))),{x:1});
for(const nested of [false,true]) {
 let traps=0;const proxy=new Proxy({}, {ownKeys(){traps++;return [];},getPrototypeOf(){traps++;return Object.prototype;},isExtensible(){traps++;return true;},get(){traps++;return undefined;}});
 const input=nested?Object.freeze(event(proxy)):proxy;const {h}=make();const before=cloneCalls;
 assert.throws(()=>h.enqueueLive(input,()=>{}),{name:'DataCloneError'});assert.equal(traps,0);assert.equal(cloneCalls-before,1);await h.close();results.push(nested?'nested proxy zero traps':'root proxy zero traps');
}
const over=Object.freeze(Array.from({length:10001},()=>Object.freeze({x:1})));
await success('large unmarked frozen graph retains clone fallback',Object.freeze(event(over)),Array.from({length:10001},()=>({x:1})));
{
 let first=true,entered,release; const started=new Promise(r=>entered=r);const gate=new Promise(r=>release=r); const writes=[];
 const {h}=make({async persistBatch(header,batch){if(first){first=false;entered();await gate;throw new Error('synthetic failure');}writes.push(...batch.map(e=>JSON.stringify(e)));}});
 h.enqueueLive(deepFreeze(event({v:'first'})),()=>{});const draining=h.drainLive();await started;
 h.enqueueLive(deepFreeze(event({v:'second'},1)),()=>{});release();await assert.rejects(draining,/synthetic failure/);
 assert.deepEqual(h.buffered.map(e=>e.seq),[0,1]);assert.equal(h.drainPaused,true);assert.equal(h.state.cursor,0);
 await h.drainLive();await h.close();assert.deepEqual(writes.map(JSON.parse),[event({v:'first'}),event({v:'second'},1)]);assert.equal(h.state.cursor,2);results.push('delayed failure requeue retry ordered JSON readback');
}
for(const [name,value] of [['Date',new Date(0)],['Map',new Map()],['boxedNumber',new Number(2)],['WeakMap',new WeakMap()]]) {Object.setPrototypeOf(value,Object.prototype);Object.freeze(value);const input=deepFreeze(event({exotic:value}));const {h}=make();let enqueueError;try{h.enqueueLive(input,()=>{});}catch(e){enqueueError=e;}if(name==='WeakMap'){assert.equal(enqueueError?.name,'DataCloneError');}else{assert.equal(enqueueError,undefined);await assert.rejects(h.drainLive(),TypeError);h.buffered.length=0;}await h.close();results.push('disguised '+name+' fallback preserves rejection');}
if(candidate){assert.equal(Session.isCanonicalLiveEvent(Object.freeze(event({}))),false);assert.equal(Session.isCanonicalLiveEvent(new Proxy({},{})),false);assert.throws(()=>{Session.isCanonicalLiveEvent=()=>true;},TypeError);results.push('provenance query read-only and no unmarked admission');}
{const originalNow=Date.now;const negativeTimeSession=Session.create('synthetic');let live;try{Date.now=()=>-0;live=negativeTimeSession.append('session/end-seed',{});}finally{Date.now=originalNow;}assert.ok(Object.is(live.time,-0));if(typeof Session.isCanonicalLiveEvent==='function')assert.equal(Session.isCanonicalLiveEvent(live),false);const {h}=make();const before=cloneCalls;h.enqueueLive(live,()=>{});assert.equal(cloneCalls-before,1);await assert.rejects(h.drainLive(),TypeError);h.buffered.length=0;await h.close();results.push('actual publication negative-zero time is unmarked fallback');}
{const fakeType=new String('session/end-seed');let live;try{live=Session.create('synthetic').append(fakeType,{});}catch{}if(live&&typeof Session.isCanonicalLiveEvent==='function')assert.equal(Session.isCanonicalLiveEvent(live),false);results.push('object-valued event type not canonical');}
{const source=new Date(0);Object.setPrototypeOf(source,Object.prototype);Object.freeze(source);const s=Session.create('synthetic');const seq=appendPluginRecord(s,'plugin:research/normalized',{spoof:source});const live=s.eventAt(seq);assert.equal(Object.getPrototypeOf(live.data.spoof),Object.prototype);assert.deepEqual(live.data.spoof,{});if(typeof Session.isCanonicalLiveEvent==='function')assert.equal(Session.isCanonicalLiveEvent(live),true);const {h,lines}=make();h.enqueueLive(live,()=>{});await h.drainLive();await h.close();assert.deepEqual(JSON.parse(lines[0]).data,{spoof:{}});results.push('actual publication normalizes disguised source to ordinary JSON');}
globalThis.structuredClone=originalClone;
console.log(JSON.stringify({mode:process.argv[2]||'installed',passed:results.length,cases:results}));
