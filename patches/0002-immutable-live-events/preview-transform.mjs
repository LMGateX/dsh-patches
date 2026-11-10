import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const root=process.env.DSH_ROOT || join(execFileSync('npm',['root','-g'],{encoding:'utf8'}).trim(),'@deepseek-ai/dsh');
export const valuesURL=pathToFileURL(join(root,'node_modules/@deepseek-ai/dsh-util-values/lib/index.js')).href;
export const writerURL=pathToFileURL(join(root,'node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js')).href;
export const sessionURL=pathToFileURL(join(root,'node_modules/@deepseek-ai/dsh-session/lib/index.js')).href;
function once(source,from,to) {assert.equal(source.split(from).length,2,'exact replacement: '+from);return source.replace(from,to);}
export function patchWriter(source) {return once(source,'this.buffered.push(structuredClone(event));','this.buffered.push(Session.isCanonicalLiveEvent?.(event) === true ? event : structuredClone(event));');}
export function patchSession(source) {
 const additions = [
 ' static #canonicalLiveEvents = new WeakSet();',
 ' /** Query publication provenance without granting callers a marking capability. */',
 ' static isCanonicalLiveEvent(event) { return Session.#canonicalLiveEvents.has(event); }',
 ' static { Object.defineProperty(this, "isCanonicalLiveEvent", { writable: false, configurable: false }); }',
 ' static #markCanonicalLiveEvent(event) {',
 '  if (typeof event.type === "string" && Number.isSafeInteger(event.seq) && event.seq >= 0 && !Object.is(event.seq, -0) && Number.isSafeInteger(event.time) && event.time >= 0 && !Object.is(event.time, -0)) Session.#canonicalLiveEvents.add(event);',
 ' }'
 ].join('\n');
 source=once(source,'var Session = class Session {','var Session = class Session {\n'+additions);
 source=once(source,'this.commit(event, entry);','Session.#markCanonicalLiveEvent(event);\n\t\tthis.commit(event, entry);');
 source=once(source,'this.commit(record, entry);','Session.#markCanonicalLiveEvent(record);\n\t\tthis.commit(record, entry);');
 return source;
}
