// Node 24.12: node --expose-gc --max-old-space-size=512 patches/0001-read-window-detach/regression.mjs
// Exercises installed code only. No patching, source hooks, session data, or external fixtures.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join as pathJoin, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

assert.equal(process.argv.length, 2, 'External fixture arguments are not supported');
assert.equal(typeof global.gc, 'function', 'Run Node with --expose-gc');
const MiB = 1024 * 1024;
const root = process.env.DSH_ROOT
  ? resolve(process.env.DSH_ROOT)
  : pathJoin(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), '@deepseek-ai/dsh');
function importRoot(packageName, entry = 'lib/index.js') {
  return import(pathToFileURL(pathJoin(root, 'node_modules', '@deepseek-ai', packageName, entry)).href);
}
const [{ apply }, { LocalFileSystem }, { ToolExecutionPipeline }] = await Promise.all([
  importRoot('dsh-tool-fs'),
  importRoot('dsh-fs-local'),
  importRoot('dsh-tools', 'lib/pipeline.js'),
]);

const tempPrefix = pathJoin(resolve(tmpdir()), 'read-window-regression-');
const directory = await mkdtemp(tempPrefix);
const fixture = pathJoin(directory, 'generated-lines.txt');
const line = 'x'.repeat(99);
const lineCount = Math.floor(9 * MiB / 100);
const pipeline = Object.create(ToolExecutionPipeline.prototype);
pipeline.canonicalResults = new WeakMap();
pipeline.concludingExecutions = new WeakSet();
const local = Object.create(LocalFileSystem.prototype);
local.config = { cwd: directory, diffBasisMaxBytes: MiB };
let wholeReads = 0;
let streamReads = 0;
const fs = {
  resolve: local.resolve.bind(local),
  stat: local.stat.bind(local),
  processPath: local.processPath.bind(local),
  readText(...args) { wholeReads++; return local.readText(...args); },
  streamText(...args) { streamReads++; return local.streamText(...args); },
};
let readTool;
const context = {
  fs,
  tools: { register(tool) { if (tool.name === 'read') readTool = tool; } },
  systemPrompt: { section() {}, getSectionOrder() { return 1; } },
  emit() {},
};
function setup({ maxBytes = 51200, streamMinSize = 10 * MiB } = {}) {
  readTool = undefined;
  apply(context, {
    read: true, readImage: false, write: false, edit: false, applyPatch: false,
    readLimit: 2000, readMaxLineLength: 2000,
    readMaxBytes: maxBytes, readStreamMinSize: streamMinSize,
  });
  assert.ok(readTool, 'Installed plugin must register read');
}
async function canonicalRead(offset, limit) {
  const args = { file_path: fixture, offset, limit };
  const execution = { signal: new AbortController().signal, arguments: args, token: Symbol() };
  const raw = await readTool.execute(args, execution);
  const result = pipeline.createSuccessResult(execution, readTool, raw);
  assert.deepEqual(result.value, raw, 'Canonical snapshot must preserve the returned value');
  assert.deepEqual(result.meta.lines, raw.lines, 'Actual presentation metadata must preserve lines');
  assert.equal(pipeline.canonicalResults.get(result), execution.token);
  assert.equal(result.meta.offset, offset);
  // Only actual presentation metadata escapes this frame: not raw, result.value, or rendered content.
  return result.meta;
}
async function collectedHeap() {
  // Let completed async frames disappear before measuring live metadata ownership.
  await new Promise(setImmediate);
  for (let i = 0; i < 3; i++) global.gc();
  return process.memoryUsage().heapUsed;
}
async function checkSemantics() {
  // One generated ~9 MiB fixture, rewritten in place for the ASCII retention measurement.
  const header = '中文汉字😀\r\n' + '中'.repeat(1999) + '😀tail\nend\n';
  const fillerCount = Math.floor((9 * MiB - Buffer.byteLength(header)) / 100);
  await writeFile(fixture, header + (line + '\n').repeat(fillerCount));
  for (const streamMinSize of [10 * MiB, 1]) {
    setup({ streamMinSize });
    const meta = await canonicalRead(1, 3);
    assert.equal(meta.totalLines, fillerCount + 3);
    assert.equal(meta.lines.length, 3);
    assert.deepEqual(meta.lines, [
      { number: 1, text: '中文汉字😀' },
      { number: 2, text: '中'.repeat(1999) + '\ud83d... (line truncated to 2000 chars)' },
      { number: 3, text: 'end' },
    ], 'CRLF stripping, Chinese, emoji, and UTF-16 split-surrogate truncation must be unchanged');
    const window = await canonicalRead(2, 1);
    assert.deepEqual(window.lines, [meta.lines[1]], 'Offset and limit select the requested numbered line');
    await assert.rejects(() => canonicalRead(fillerCount + 4, 1), /offset .* is out of range/);
    // UTF-8 bytes, not UTF-16 code units: the first line is exactly 16 bytes.
    setup({ maxBytes: 16, streamMinSize });
    const exact = await canonicalRead(1, 2);
    assert.deepEqual(exact.lines, [{ number: 1, text: '中文汉字😀' }]);
    assert.equal(Buffer.byteLength(exact.lines[0].text), 16);
    setup({ maxBytes: 15, streamMinSize });
    assert.deepEqual((await canonicalRead(1, 2)).lines, []);
    // Separator accounting: 99 + 1 + 99 = 199 bytes; a 198-byte cap permits only one line.
    for (const [maxBytes, count] of [[199, 2], [198, 1]]) {
      setup({ maxBytes, streamMinSize });
      const capped = await canonicalRead(4, 3);
      assert.equal(capped.totalLines, fillerCount + 3);
      assert.deepEqual(capped.lines, Array.from({ length: count }, (_, i) => ({ number: 4 + i, text: line })));
      assert.equal(Buffer.byteLength(capped.lines.map(item => item.text).join('\n')), count === 2 ? 199 : 99);
    }
  }
  console.log('PASS semantics: offset/limit/totalLines, Chinese/emoji/CRLF/split-surrogate, UTF-8 byte caps (whole + stream)');
}
async function checkRetention() {
  await writeFile(fixture, (line + '\n').repeat(lineCount));
  const fileBytes = (await stat(fixture)).size;
  assert.equal(fileBytes, lineCount * 100);
  assert.ok(fileBytes > 8.9 * MiB && fileBytes < 9 * MiB);
  setup();
  await canonicalRead(1, 1); // Warm installed schema/render/projection code before the baseline.
  const before = await collectedHeap();
  const readsBefore = wholeReads;
  const streamsBefore = streamReads;
  const retained = [];
  for (let i = 0; i < 12; i++) retained.push(await canonicalRead(i + 1, 1));
  const after = await collectedHeap();
  // Touch retained metadata after GC so these are live roots throughout the measurement.
  assert.equal(retained.length, 12);
  for (let i = 0; i < retained.length; i++) {
    assert.equal(retained[i].totalLines, lineCount);
    assert.deepEqual(retained[i].lines, [{ number: i + 1, text: line }]);
  }
  const returnedLines = retained.reduce((sum, meta) => sum + meta.lines.length, 0);
  const returnedChars = retained.reduce((sum, meta) => sum + meta.lines[0].text.length, 0);
  assert.equal(returnedLines, 12);
  assert.equal(returnedChars, 1188);
  assert.equal(wholeReads - readsBefore, 12, 'Retention case must exercise whole-file reads below the default threshold');
  assert.equal(streamReads - streamsBefore, 0);
  const retainedMiB = (after - before) / MiB;
  console.log(JSON.stringify({ reads: 12, fixtureBytes: fileBytes, returnedLines, returnedChars,
    wholeReads: wholeReads - readsBefore, streamReads: streamReads - streamsBefore,
    retainedHeapMiB: Number(retainedMiB.toFixed(3)), limitMiB: 16, retaining: 'canonical presentation metadata only' }));
  assert.ok(after - before < 16 * MiB,
    'Twelve single-line canonical metadata windows must retain <16 MiB after GC');
  console.log('PASS retention: bounded canonical metadata heap');
}
try {
  await checkSemantics();
  await checkRetention();
} catch (error) {
  // Keep ordinary regression output compact and free of host-specific stack paths.
  console.error(error instanceof assert.AssertionError ? 'FAIL: ' + error.message : 'FAIL: installed read regression could not complete');
  process.exitCode = 1;
} finally {
  // This process may remove only its own mkdtemp directory and generated fixture.
  assert.ok(isAbsolute(directory) && directory.startsWith(tempPrefix) &&
    resolve(directory) === directory && !directory.slice(tempPrefix.length).includes(sep) &&
    resolve(fixture).startsWith(directory + sep), 'Refusing unsafe fixture cleanup');
  await rm(directory, { recursive: true, force: true });
}
