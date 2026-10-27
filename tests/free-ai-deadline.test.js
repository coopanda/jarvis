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

 test('keyless POST keeps full context private and uses short explicit generation limit', async () => {
  const result = await fresh()({ prompt: 'private prompt', system: 'full policy', log: silent, fetchImpl: async (url, opts) => {
    assert.equal(url, 'https://text.pollinations.ai/openai');
    assert.equal(opts.method, 'POST');
    assert.equal(opts.redirect, 'error');
    assert.deepEqual(opts.headers, { 'Content-Type': 'application/json' });
    const body = JSON.parse(opts.body);
    assert.equal(body.model, 'openai-fast');
    assert.equal(body.stream, false);
    assert.equal(body.max_tokens, 384);
    assert.deepEqual(body.messages, [{ role: 'system', content: 'full policy' }, { role: 'user', content: 'private prompt' }]);
    return ok;
  }});
  assert.equal(result.reply, 'OK');
});

test('local greetings are instant and do not consume provider quota', async () => {
  for (const prompt of ['hey Jarvis', 'hi', 'Hello, Jarvis!', 'Jarvis']) {
    const result = await fresh()({ prompt, fetchImpl: () => { throw new Error('must not fetch'); } });
    assert.match(result.reply, /Hey!/);
    assert.equal(result.tool, null);
    assert.equal(result.unavailable, undefined);
  }
});

test('primary timeout tries text POST fallback with a fresh signal', async () => {
  const calls = [], logs = [];
  const start = performance.now();
  const result = await fresh()({ prompt: 'SECRET_PROMPT', timeoutMs: 300, attemptMs: 30, log: line => logs.push(line), fetchImpl: async (url, opts) => {
    calls.push({ url, signal: opts.signal });
    return calls.length === 1 ? never() : ok;
  }});
  assert.equal(result.reply, 'OK');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, 'https://text.pollinations.ai/');
  assert.notEqual(calls[0].signal, calls[1].signal);
  assert.ok(calls[0].signal.aborted);
  assert.ok(performance.now() - start < 1000);
  assert.ok(!logs.join('').includes('SECRET_PROMPT'));
});

test('total deadline and hung body reads return graceful replies, not timeout errors', async () => {
  for (const fetchImpl of [never, async () => ({ ok: true, json: never })]) {
    const result = await fresh()({ prompt: 'question', timeoutMs: 40, attemptMs: 100, fetchImpl, log: silent });
    assert.equal(result.unavailable, true);
    assert.equal(result.tool, null);
    assert.ok(result.retryAfterSeconds > 0);
    assert.doesNotMatch(result.reply, /timed out|endpoint rejected|402/i);
  }
});

test('HTTP failures, invalid responses, and network failures gracefully exhaust', async () => {
  for (const fetchImpl of [async () => rejected(500), async () => { throw new Error('SECRET_UPSTREAM'); }, async () => ({ ok: true, json: async () => ({}) }), async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '<html>bad</html>' } }] }), text: async () => '' })]) {
    const logs = [];
    const result = await fresh()({ prompt: 'question', fetchImpl, log: line => logs.push(line) });
    assert.equal(result.unavailable, true);
    assert.doesNotMatch(result.reply + logs.join(''), /SECRET_UPSTREAM/);
  }
});

test('402 and 429 honor host-wide Retry-After without trying another path', async () => {
  for (const status of [402, 429]) {
    const f = clockFixture();
    let count = 0;
    const options = { prompt: 'question', log: silent, fetchImpl: async () => { count++; return rejected(status, '120'); } };
    const result = await f.generate(options);
    assert.equal(result.unavailable, true);
    assert.equal(result.retryAfterSeconds, 120);
    assert.equal(count, 1);
    f.advance(119000);
    await f.generate(options);
    assert.equal(count, 1);
    f.advance(1000);
    await f.generate(options);
    assert.equal(count, 2);
  }
});

test('Retry-After handles seconds, HTTP date, invalid input, and long cooldowns', () => {
  const time = Date.parse('2026-10-26T00:00:00Z');
  assert.equal(retryAfterMs('120', time), 120000);
  assert.equal(retryAfterMs('Mon, 26 Oct 2026 00:02:00 GMT', time), 120000);
  assert.equal(retryAfterMs('86400', time), 86400000);
  assert.equal(retryAfterMs('0', time), 1000);
  assert.equal(retryAfterMs('bad', time), 60000);
  assert.equal(retryAfterMs(null, time), 60000);
});

test('configured Groq is primary and never sends its key to Pollinations or logs', async () => {
  const f = createFreeBrain({ env: { GROQ_API_KEY: 'TEST_ONLY_KEY', GROQ_FREE_MODEL: 'fast-test' } });
  let calls = 0;
  const logs = [];
  const result = await f({ prompt: 'question', log: line => logs.push(line), fetchImpl: async (url, opts) => {
    calls++;
    assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions');
    assert.equal(opts.headers.Authorization, 'Bearer TEST_ONLY_KEY');
    assert.equal(JSON.parse(opts.body).model, 'fast-test');
    return ok;
  }});
  assert.equal(result.reply, 'OK');
  assert.equal(calls, 1);
  assert.ok(!logs.join('').includes('TEST_ONLY_KEY'));
});

test('primary 402 immediately falls back to an independent host and retains cooldown', async () => {
  const f = clockFixture({ GROQ_API_KEY: 'TEST_ONLY_KEY' });
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push(url);
    if (url.includes('groq.com')) return rejected(402, '120');
    assert.equal(opts.headers.Authorization, undefined);
    return ok;
  };
  const result = await f.generate({ prompt: 'question', fetchImpl, hedgeMs: 4000, log: silent });
  assert.equal(result.reply, 'OK');
  assert.equal(calls.length, 2);
  f.advance(31000);
  await f.generate({ prompt: 'question', fetchImpl, log: silent });
  assert.equal(calls.filter(url => url.includes('groq.com')).length, 1);
});

test('slow primary is hedged; fast Cerebras wins and the loser is cancelled', async () => {
  const f = createFreeBrain({ env: { GROQ_API_KEY: 'TEST_GROQ', CEREBRAS_API_KEY: 'TEST_CEREBRAS', CEREBRAS_FREE_MODEL: 'fast-test' } });
  const calls = [];
  let losingSignal;
  const start = performance.now();
  const result = await f({ prompt: 'question', timeoutMs: 500, attemptMs: 400, hedgeMs: 20, log: silent, fetchImpl: async (url, opts) => {
    calls.push(url);
    if (url.includes('groq.com')) { losingSignal = opts.signal; return never(); }
    assert.equal(url, 'https://api.cerebras.ai/v1/chat/completions');
    assert.equal(opts.headers.Authorization, 'Bearer TEST_CEREBRAS');
    return ok;
  }});
  assert.equal(result.reply, 'OK');
  assert.equal(calls.length, 2);
  assert.ok(losingSignal.aborted);
  assert.ok(performance.now() - start < 350);
});

test('successful anonymous requests and concurrent calls respect host cooldown/occupancy', async () => {
  const f = clockFixture();
  let count = 0;
  const options = { prompt: 'question', fetchImpl: async () => { count++; return ok; }, log: silent };
  await f.generate(options);
  const waiting = await f.generate(options);
  assert.equal(waiting.unavailable, true);
  assert.equal(count, 1);
  f.advance(30000);
  await f.generate(options);
  assert.equal(count, 2);
  const g = fresh();
  const pending = g({ prompt: 'question', fetchImpl: never, timeoutMs: 30, log: silent });
  const concurrent = await g({ prompt: 'question', fetchImpl: () => { throw new Error('must not fetch'); }, log: silent });
  assert.equal(concurrent.unavailable, true);
  await pending;
});

test('caller cancellation is preserved and vision is not silently downgraded', async () => {
  const controller = new AbortController();
  const reason = new DOMException('Cancelled', 'AbortError');
  controller.abort(reason);
  await assert.rejects(fresh()({ prompt: 'question', signal: controller.signal, fetchImpl: never }), e => e === reason);
  const runningController = new AbortController();
  const promise = fresh()({ prompt: 'question', signal: runningController.signal, fetchImpl: never, log: silent });
  runningController.abort(reason);
  await assert.rejects(promise, e => e === reason);
  await assert.rejects(fresh()({ prompt: 'question', image: 'image' }), /text-only/);
});

test('fallback eligibility includes billing, quotas, unconfigured providers and deadlines', () => {
  for (const status of [401, 402, 429, 503, 504]) assert.ok(isFreeFallbackError({ providerStatus: status }));
  assert.ok(isFreeFallbackError({ message: 'Provider not configured' }));
  assert.equal(isFreeFallbackError({ name: 'AbortError', status: 504 }), false);
  assert.equal(isFreeFallbackError({ status: 403 }), false);
});
