import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { freeBrain } from '../free-ai.js';
const ok = { ok: true, json: async () => ({ choices: [{ message: { content: '{"reply":"OK","tool":null}' } }] }), text: async () => '{"reply":"OK","tool":null}' };
const silent = () => {};
const never = () => new Promise(() => {});

test('documented keyless route, explicit fast model and no credentials or GET context', async () => {
  const result = await freeBrain({ prompt: 'private prompt', log: silent, fetchImpl: async (url, opts) => {
    assert.equal(url, 'https://text.pollinations.ai/openai');
    assert.equal(opts.method, 'POST');
    assert.deepEqual(opts.headers, { 'Content-Type': 'application/json' });
    const body = JSON.parse(opts.body);
    assert.equal(body.model, 'openai-fast');
    assert.equal(body.stream, false);
    assert.equal(body.max_tokens, 768);
    return ok;
  } });
  assert.equal(result.reply, 'OK');
});

test('primary timeout actually attempts independent POST fallback', async () => {
  const calls = [], logs = [];
  const start = performance.now();
  const result = await freeBrain({ prompt: 'SECRET_PROMPT', timeoutMs: 200, attemptMs: 35, log: s => logs.push(JSON.parse(s)), fetchImpl: async (url, opts) => {
    calls.push({ url, signal: opts.signal });
    return calls.length === 1 ? never() : ok;
  } });
  assert.equal(result.reply, 'OK');
  assert.deepEqual(calls.map(c => c.url), ['https://text.pollinations.ai/openai', 'https://text.pollinations.ai/']);
  assert.equal(calls[0].signal.aborted, true);
  assert.notEqual(calls[0].signal, calls[1].signal);
  assert.equal(logs[0].status, 504);
  assert.equal(logs[1].status, 'ok');
  assert.ok(logs.every(l => Number.isFinite(l.elapsedMs) && Number.isFinite(l.totalMs)));
  assert.ok(!JSON.stringify(logs).includes('SECRET_PROMPT'));
  assert.ok(performance.now() - start < 500);
});

test('total deadline bounds hangs including fetch implementations ignoring abort', async () => {
  let calls = 0;
  const start = performance.now();
  await assert.rejects(freeBrain({ prompt: 'hi', timeoutMs: 90, attemptMs: 60, log: silent, fetchImpl: () => { calls++; return never(); } }), e => e.status === 504);
  assert.equal(calls, 2);
  assert.ok(performance.now() - start < 400);
});

test('body read is timed out and can fall back too', async () => {
  let calls = 0;
  const result = await freeBrain({ prompt: 'hi', timeoutMs: 150, attemptMs: 30, log: silent, fetchImpl: async () => ++calls === 1 ? { ok: true, json: never } : ok });
  assert.equal(result.reply, 'OK');
  assert.equal(calls, 2);
});

test('malformed successful response falls back rather than reporting success', async () => {
  let calls = 0;
  const result = await freeBrain({ prompt: 'hi', log: silent, fetchImpl: async () => ++calls === 1 ? { ok: true, json: async () => ({}) } : ok });
  assert.equal(result.reply, 'OK');
  assert.equal(calls, 2);
});

test('caller cancellation does not retry', async () => {
  const controller = new AbortController();
  let calls = 0;
  const pending = freeBrain({ prompt: 'hi', signal: controller.signal, log: silent, fetchImpl: () => { calls++; return never(); } });
  controller.abort();
  await assert.rejects(pending, e => e.name === 'AbortError');
  assert.equal(calls, 1);
});

test('rate limits preserve status and cooldown does not evade shared-IP limits', async () => {
  let calls = 0;
  const run = () => freeBrain({ prompt: 'hi', log: silent, fetchImpl: async () => { calls++; return { ok: false, status: 429, headers: { get: () => '60' } }; } });
  await assert.rejects(run(), e => e.providerStatus === 429 && e.status === 503);
  await assert.rejects(run(), /rate limited/);
  assert.equal(calls, 1);
});
