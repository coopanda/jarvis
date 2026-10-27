import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createFreeBrain, retryAfterMs, isFreeFallbackError } from '../free-ai.js';

const ok = { ok: true, json: async () => ({ choices: [{ message: { content: '{"reply":"OK","tool":null}' } }] }), text: async () => '{"reply":"OK","tool":null}' };
const silent = () => {};
const never = () => new Promise(() => {});
const rejected = (status, retry = null) => ({ ok: false, status, headers: { get: name => name === 'retry-after' ? retry : null } });
const fresh = () => createFreeBrain({ env: {} });

function clockFixture(env = {}) {
  let time = Date.parse('2026-10-26T00:00:00Z');
  return { generate: createFreeBrain({ env, now: () => time }), advance: ms => { time += ms; }, now: () => time };
}

test('documented keyless POST, explicit model, private context and no credentials', async () => {
  const result = await fresh()({ prompt: 'private prompt', log: silent, fetchImpl: async (url, opts) => {
    assert.equal(url, 'https://text.pollinations.ai/openai');
    assert.equal(opts.method, 'POST');
    assert.equal(opts.redirect, 'error');
    assert.deepEqual(opts.headers, { 'Content-Type': 'application/json' });
    const body = JSON.parse(opts.body);
    assert.equal(body.model, 'openai-fast');
    assert.equal(body.stream, false);
    assert.equal(body.max_tokens, 768);
    assert.equal(body.messages[1].content, 'private prompt');
    return ok;
  } });
  assert.equal(result.reply, 'OK');
});

test('primary timeout attempts plain-text POST fallback with fresh signal', async () => {
  const calls = [], logs = [];
  const start = performance.now();
  const result = await fresh()({ prompt: 'SECRET_PROMPT', timeoutMs: 200, attemptMs: 35, log: s => logs.push(JSON.parse(s)), fetchImpl: async (url, opts) => {
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
  assert.ok(performance.now() - start < 1000);
});

test('total deadline includes headers and response body reading', async () => {
  const start = performance.now();
  await assert.rejects(fresh()({ prompt: 'hi', timeoutMs: 100, attemptMs: 30, log: silent, fetchImpl: async () => ({ ok: true, json: never, text: never }) }), { status: 504 });
  assert.ok(performance.now() - start < 1000);
});

test('HTTP errors try alternate POST but never exceed total budget', async () => {
  let calls = 0;
  await assert.rejects(fresh()({ prompt: 'hi', log: silent, fetchImpl: async () => { calls++; return rejected(500); } }), { providerStatus: 500 });
  assert.equal(calls, 2);
});

test('caller abort immediately cancels without fallback', async () => {
  const controller = new AbortController();
  const reason = new Error('cancelled by caller');
  let calls = 0;
  const promise = fresh()({ prompt: 'hi', signal: controller.signal, log: silent, fetchImpl: async () => { calls++; return never(); } });
  controller.abort(reason);
  await assert.rejects(promise, actual => actual === reason);
  assert.equal(calls, 1);
});

test('already aborted and text-only guard do not contact providers', async () => {
  const controller = new AbortController();
  controller.abort();
  const fetchImpl = async () => { throw Error('unexpected network'); };
  await assert.rejects(fresh()({ prompt: 'hi', signal: controller.signal, fetchImpl, log: silent }), { name: 'AbortError' });
  await assert.rejects(fresh()({ prompt: 'hi', image: 'data:image/jpeg;base64,test', fetchImpl, log: silent }), /text-only/);
});

test('empty and HTML responses remain rejected', async () => {
  for (const content of ['', '<!doctype html><html>error</html>', '{"reply":""}']) {
    await assert.rejects(fresh()({ prompt: 'hi', log: silent, fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }), text: async () => content }) }), { status: 502 });
  }
});

test('Retry-After accepts seconds and HTTP dates without shortening long limits', () => {
  const now = Date.parse('2026-10-26T00:00:00Z');
  assert.equal(retryAfterMs('120', now), 120000);
  assert.equal(retryAfterMs('900', now), 900000);
  assert.equal(retryAfterMs('Mon, 26 Oct 2026 00:02:00 GMT', now), 120000);
  assert.equal(retryAfterMs(null, now), 60000);
  assert.equal(retryAfterMs('', now), 60000);
  assert.equal(retryAfterMs('invalid', now), 60000);
  assert.equal(retryAfterMs('0', now), 1000);
});

for (const status of [402, 429]) {
  test(`${status} returns friendly text, skips same-host retry and honors cooldown`, async () => {
    const f = clockFixture();
    const calls = [];
    const request = () => f.generate({ prompt: 'hi', log: silent, fetchImpl: async url => { calls.push(url); return rejected(status, '120'); } });
    const first = await request();
    assert.equal(first.unavailable, true);
    assert.equal(first.tool, null);
    assert.equal(first.retryAfterSeconds, 120);
    assert.match(first.reply, /temporarily busy/);
    assert.ok(!first.reply.includes(String(status)));
    f.advance(119000);
    assert.equal((await request()).retryAfterSeconds, 1);
    assert.equal(calls.length, 1);
    f.advance(1000);
    await request();
    assert.equal(calls.length, 2);
    assert.ok(calls.every(url => url === 'https://text.pollinations.ai/openai'));
  });

  test(`${status} uses distinct Groq free-tier fallback without leaking key or context`, async () => {
    const key = 'unit-test-placeholder';
    const f = clockFixture({ GROQ_API_KEY: key });
    const calls = [], logs = [];
    const request = () => f.generate({ prompt: 'PRIVATE_PROMPT', log: line => logs.push(JSON.parse(line)), fetchImpl: async (url, opts) => {
      calls.push(url);
      if (url.startsWith('https://text.pollinations.ai')) {
        assert.equal(opts.headers.Authorization, undefined);
        return rejected(status, '120');
      }
      assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions');
      assert.equal(opts.headers.Authorization, `Bearer ${key}`);
      assert.equal(JSON.parse(opts.body).model, 'llama-3.1-8b-instant');
      return ok;
    } });
    assert.equal((await request()).reply, 'OK');
    assert.equal((await request()).reply, 'OK');
    assert.deepEqual(calls, ['https://text.pollinations.ai/openai', 'https://api.groq.com/openai/v1/chat/completions', 'https://api.groq.com/openai/v1/chat/completions']);
    assert.ok(!JSON.stringify(logs).includes(key));
    assert.ok(!JSON.stringify(logs).includes('PRIVATE_PROMPT'));
    assert.equal(logs[1].provider, 'groq');
  });
}

test('HTTP-date Retry-After is honored at the actual request boundary', async () => {
  const f = clockFixture();
  let calls = 0;
  const request = () => f.generate({ prompt: 'hi', log: silent, fetchImpl: async () => { calls++; return rejected(402, 'Mon, 26 Oct 2026 00:02:00 GMT'); } });
  assert.equal((await request()).retryAfterSeconds, 120);
  f.advance(60000);
  assert.equal((await request()).retryAfterSeconds, 60);
  assert.equal(calls, 1);
  f.advance(60000);
  await request();
  assert.equal(calls, 2);
});

test('missing Retry-After gets a safe default cooldown', async () => {
  const f = clockFixture();
  let calls = 0;
  const request = () => f.generate({ prompt: 'hi', log: silent, fetchImpl: async () => { calls++; return rejected(402); } });
  assert.equal((await request()).retryAfterSeconds, 60);
  await request();
  assert.equal(calls, 1);
});

test('success also enforces 30-second anonymous spacing', async () => {
  const f = clockFixture();
  let calls = 0;
  const request = () => f.generate({ prompt: 'hi', log: silent, fetchImpl: async () => { calls++; return ok; } });
  assert.equal((await request()).reply, 'OK');
  assert.equal((await request()).retryAfterSeconds, 30);
  f.advance(29999);
  await request();
  assert.equal(calls, 1);
  f.advance(1);
  assert.equal((await request()).reply, 'OK');
  assert.equal(calls, 2);
});

test('both providers rate limited produce friendly text and preserve separate cooldowns', async () => {
  const f = clockFixture({ GROQ_API_KEY: 'unit-test-placeholder' });
  const calls = [];
  const request = () => f.generate({ prompt: 'hi', log: silent, fetchImpl: async url => { calls.push(url); return rejected(url.includes('groq') ? 429 : 402, url.includes('groq') ? '60' : '120'); } });
  assert.equal((await request()).retryAfterSeconds, 60);
  assert.equal((await request()).unavailable, true);
  assert.equal(calls.length, 2);
  f.advance(60000);
  await request();
  assert.equal(calls.length, 3);
  assert.ok(calls[2].includes('groq'));
});

test('concurrent requests do not start two anonymous calls', async () => {
  const f = clockFixture();
  let release, calls = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const request = () => f.generate({ prompt: 'hi', log: silent, fetchImpl: async () => { calls++; return pending; } });
  const first = request();
  assert.equal((await request()).unavailable, true);
  assert.equal(calls, 1);
  release(ok);
  assert.equal((await first).reply, 'OK');
});

test('Groq is independent after a network failure and supports an env model override', async () => {
  const generate = createFreeBrain({ env: { GROQ_API_KEY: 'unit-test-placeholder', GROQ_FREE_MODEL: 'llama-3.3-70b-versatile' } });
  let calls = 0;
  const result = await generate({ prompt: 'hi', log: silent, fetchImpl: async (url, opts) => {
    calls++;
    if (!url.includes('groq')) throw Error('network failed');
    assert.equal(JSON.parse(opts.body).model, 'llama-3.3-70b-versatile');
    return ok;
  } });
  assert.equal(result.reply, 'OK');
  assert.equal(calls, 2);
});

test('402 is a fallback-triggering error; permission denial and abort are not', () => {
  assert.equal(isFreeFallbackError({ providerStatus: 402 }), true);
  assert.equal(isFreeFallbackError({ status: 402 }), true);
  assert.equal(isFreeFallbackError(new Error('Provider request rejected (402)')), true);
  assert.equal(isFreeFallbackError({ providerStatus: 429 }), true);
  assert.equal(isFreeFallbackError({ status: 403 }), false);
  assert.equal(isFreeFallbackError({ name: 'AbortError', providerStatus: 402 }), false);
});
