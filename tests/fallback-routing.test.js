import test from 'node:test';
import assert from 'node:assert/strict';
import { createIntegrationSuite } from '../integrations.js';

// Exercise the real router with an injected brain: no network, keys or disk IO.
const reply = { reply: 'unit-test reply', tool: null };
function fixture(env = {}, implementation = async () => reply) {
  const calls = [];
  const suite = createIntegrationSuite({
    env,
    brain: async (...args) => { calls.push(args); return implementation(...args); },
    files: {},
    write: () => { throw new Error('Unexpected disk IO'); },
    audit: () => {},
    validateURL: value => value,
    isDurable: () => false,
    fetchImpl: async () => { throw new Error('Unexpected network IO'); }
  });
  return { generate: suite.generate, calls };
}
const providerError = (status, property = 'providerStatus') =>
  Object.assign(new Error('Provider request failed'), { [property]: status });

for (const failure of ['unreachable', 'timeout', 401, 429, 500]) {   test(`Hermes ${failure} falls back to Free AI without opt-in`, async () => {     const error = typeof failure === 'number' ? providerError(failure) : Object.assign(new Error(failure), { code: failure === 'timeout' ? 'ETIMEDOUT' : 'ECONNREFUSED' });     const { generate, calls } = fixture({ HERMES_API_KEY: 'unit-test-placeholder', OPENAI_API_KEY: 'unit-test-placeholder' }, async provider => {       if (provider === 'hermes') throw error;       return reply;     });     const result = await generate('hermes', 'Hello', undefined, undefined, false);     assert.deepEqual(calls.map(call => call[0]), ['hermes', 'pollinations']);     assert.deepEqual(result.routing, { requested: 'hermes', used: 'pollinations', fallback: true });     assert.equal(result.reply, reply.reply);   }); }  test('configured Hermes succeeds without fallback', async () => {   const { generate, calls } = fixture({ HERMES_API_KEY: 'unit-test-placeholder' });   const result = await generate('hermes', 'Hello');   assert.deepEqual(calls.map(call => call[0]), ['hermes']);   assert.equal(result.routing.fallback, false); });  for (const provider of ['hermes', 'openai', 'claude', 'opus', 'grok', 'gemini', 'openrouter']) {
  test(`missing ${provider} credentials use keyless Pollinations`, async () => {
    const { generate, calls } = fixture();
    const result = await generate(provider, 'Hello');
    assert.deepEqual(calls.map(call => call[0]), ['pollinations']);
    assert.deepEqual(result.routing, { requested: provider, used: 'pollinations', fallback: true });
    assert.equal(result.reply, reply.reply);
  });
}

for (const requested of [undefined, 'auto', 'pollinations', 'free']) {
  test(`keyless default/alias: ${String(requested)}`, async () => {
    const { generate, calls } = fixture();
    const result = await generate(requested, 'Hello');
    assert.deepEqual(calls.map(call => call[0]), ['pollinations']);
    assert.equal(result.routing.used, 'pollinations');
    assert.equal(result.routing.requested, requested === 'free' ? 'pollinations' : requested);
    assert.equal(result.routing.fallback, false);
  });
}

for (const preferred of ['free', 'pollinations']) {
  test(`explicit keyless default ${preferred} wins over a configured provider`, async () => {
    const { generate, calls } = fixture({ OPENAI_API_KEY: 'unit-test-placeholder', JARVIS_DEFAULT_BRAIN: preferred });
    const result = await generate('auto', 'Hello');
    assert.deepEqual(calls.map(call => call[0]), ['pollinations']);
    assert.equal(result.routing.fallback, false);
  });
}

test('a configured provider succeeds without fallback and receives context, system and signal', async () => {
  const signal = new AbortController().signal;
  const { generate, calls } = fixture({ OPENAI_API_KEY: 'unit-test-placeholder' });
  const result = await generate('openai', 'Hello', 'System instructions', signal);
  assert.deepEqual(calls, [['openai', 'Hello', 'System instructions', signal]]);
  assert.deepEqual(result.routing, { requested: 'openai', used: 'openai', fallback: false });
  assert.equal(result.reply, reply.reply);
});

for (const property of ['providerStatus', 'status']) {
  for (const status of [401, 429, 503]) {
    test(`${property} ${status} automatically falls back even when allowFallback is false`, async () => {
      const error = providerError(status, property);
      const { generate, calls } = fixture({ OPENAI_API_KEY: 'unit-test-placeholder' }, async provider => {
        if (provider === 'openai') throw error;
        return reply;
      });
      const result = await generate('openai', 'Hello', undefined, undefined, false);
      assert.deepEqual(calls.map(call => call[0]), ['openai', 'pollinations']);
      assert.deepEqual(result.routing, { requested: 'openai', used: 'pollinations', fallback: true });
      assert.equal(result.reply, reply.reply);
    });
  }
}

for (const error of [
  providerError(403, 'status'),
  providerError(400, 'status'),
  Object.assign(new Error('Cancelled'), { name: 'AbortError' })
]) {
  test(`preserve ${error.name}/${error.status || 'abort'} without fallback, even when enabled`, async () => {
    const { generate, calls } = fixture({ OPENAI_API_KEY: 'unit-test-placeholder' }, async () => { throw error; });
    await assert.rejects(generate('openai', 'Hello', undefined, undefined, true), actual => actual === error);
    assert.deepEqual(calls.map(call => call[0]), ['openai']);
  });
}

test('an aborted signal prevents fallback on a provider 429', async () => {
  const controller = new AbortController();
  const error = providerError(429);
  const { generate, calls } = fixture({ OPENAI_API_KEY: 'unit-test-placeholder' }, async () => {
    controller.abort();
    throw error;
  });
  await assert.rejects(generate('openai', 'Hello', undefined, controller.signal, true), actual => actual === error);
  assert.deepEqual(calls.map(call => call[0]), ['openai']);
});

test('ordinary provider errors do not automatically fall back', async () => {
  const error = providerError(500);
  const { generate, calls } = fixture({ OPENAI_API_KEY: 'unit-test-placeholder' }, async () => { throw error; });
  await assert.rejects(generate('openai', 'Hello'), actual => actual === error);
  assert.deepEqual(calls.map(call => call[0]), ['openai']);
});

test('direct Pollinations failure is propagated once without retry', async () => {
  const error = providerError(429);
  const { generate, calls } = fixture({}, async () => { throw error; });
  await assert.rejects(generate('pollinations', 'Hello', undefined, undefined, true), actual => actual === error);
  assert.deepEqual(calls.map(call => call[0]), ['pollinations']);
});

test('failed keyless fallback is propagated without retry or fallback loops', async () => {
  const error = providerError(429);
  const { generate, calls } = fixture({ OPENAI_API_KEY: 'unit-test-placeholder' }, async () => { throw error; });
  await assert.rejects(generate('openai', 'Hello', undefined, undefined, true), actual => actual === error);
  assert.deepEqual(calls.map(call => call[0]), ['openai', 'pollinations']);
});

test('unknown providers remain rejected before invoking a brain', async () => {
  const { generate, calls } = fixture();
  await assert.rejects(generate('unknown-provider', 'Hello'), { status: 400 });
  assert.deepEqual(calls, []);
});
