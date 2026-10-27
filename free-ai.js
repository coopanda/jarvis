// Server-side provider race. Free tiers are quota-limited, not unlimited.
// Configure GROQ_API_KEY or CEREBRAS_API_KEY for independent low-latency backups.
// No credentials or prompts in URLs, and no upstream error bodies in replies/logs.
const error = (message, status = 503, extra = {}) => Object.assign(new Error(message), { status, ...extra });

export function retryAfterMs(value, now = Date.now()) {
  if (typeof value !== 'string' || !value.trim()) return 60000;
  const seconds = Number(value);
  const duration = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(duration) ? Math.max(1000, duration) : 60000;
}

function parseReply(reply) {
  if (typeof reply !== 'string' || !reply.trim() || /^\s*(?:<!doctype|<html)/i.test(reply))
    throw error('No readable provider answer.', 502);
  let parsed;
  try { parsed = JSON.parse(reply.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')); }
  catch { parsed = { reply, tool: null }; }
  if (!parsed || typeof parsed.reply !== 'string' || !parsed.reply.trim())
    throw error('Invalid provider response.', 502);
  return parsed;
}

export function createFreeBrain({ env = process.env, now = Date.now } = {}) {
  const cooldown = { pollinations: 0, groq: 0, cerebras: 0 };
  const active = { pollinations: false, groq: false, cerebras: false };
  return async function generate({ prompt, system = '', image, signal, model = 'openai-fast', fetchImpl = fetch,
    timeoutMs = 12000, attemptMs = 8000, hedgeMs = 1500, log = console.warn }) {
    signal?.throwIfAborted();
    if (image) throw error('Free AI is text-only. Select a configured vision provider.');
    // A transparent local greeting is instant even while every remote is cooling down.
    // Never synthesize answers or tool actions locally for substantive requests.
    if (/^\s*(?:(?:hey|hi|hello)(?:[ ,]+jarvis)?|jarvis)[!.?\s]*$/i.test(prompt))
      return { reply: "Hey! I'm here. What can I help you with?", tool: null };
    const started = Date.now();
    const budget = Math.min(12000, Math.max(1, timeoutMs));
    const messages = [{ role: 'system', content: system }, { role: 'user', content: prompt }];
    const providers = [
      ...(env.GROQ_API_KEY ? [{ id: 'groq', base: 'https://api.groq.com', paths: ['/openai/v1/chat/completions'], model: env.GROQ_FREE_MODEL || 'llama-3.1-8b-instant', key: env.GROQ_API_KEY }] : []),
      ...(env.CEREBRAS_API_KEY ? [{ id: 'cerebras', base: 'https://api.cerebras.ai', paths: ['/v1/chat/completions'], model: env.CEREBRAS_FREE_MODEL || 'llama3.1-8b', key: env.CEREBRAS_API_KEY }] : []),
      { id: 'pollinations', base: 'https://text.pollinations.ai', paths: ['/openai', '/'], model }
    ];
    const safeLog = entry => { try { log(JSON.stringify(entry)); } catch {} };
    const graceful = () => {
      const future = providers.map(p => active[p.id] ? now() + 5000 : cooldown[p.id]).filter(t => t > now());
      const retryAfterSeconds = Math.max(1, Math.ceil(((future.length ? Math.min(...future) : now() + 5000) - now()) / 1000));
      return { reply: `I'm here, but my online AI providers are busy. Please try again in ${retryAfterSeconds} seconds or choose a configured provider.`, tool: null, unavailable: true, retryAfterSeconds };
    };
    const candidates = providers.filter(p => now() >= cooldown[p.id] && !active[p.id]);
    if (!candidates.length) return graceful();
    const lifetime = new AbortController();
    const combined = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
    let finished = false, next = 0, running = 0, deadline, hedge;
    return await new Promise((resolve, reject) => {
      const finish = (reply, cause) => {
        if (finished) return;
        finished = true;
        clearTimeout(deadline);
        clearTimeout(hedge);
        combined.removeEventListener('abort', onAbort);
        lifetime.abort(); // Cancel losing requests and their body reads.
        if (cause) reject(cause); else resolve(reply);
      };
      const onAbort = () => finish(null, signal?.reason || error('Request cancelled.', 499));
      combined.addEventListener('abort', onAbort, { once: true });
      deadline = setTimeout(() => finish(graceful()), budget);
      async function request(provider) {
        active[provider.id] = true;
        try {
          for (const path of provider.paths) {
            if (finished) return;
            const remaining = budget - (Date.now() - started);
            if (remaining <= 0) return;
            const controller = new AbortController();
            const attemptSignal = AbortSignal.any([combined, controller.signal]);
            let timer, abortListener;
            const attemptStarted = Date.now();
            try {
              const aborted = new Promise((_, fail) => {
                abortListener = () => fail(attemptSignal.reason || error('Request cancelled.', 499));
                attemptSignal.addEventListener('abort', abortListener, { once: true });
                if (attemptSignal.aborted) abortListener();
                timer = setTimeout(() => controller.abort(error('Provider deadline.', 504)), Math.min(attemptMs, remaining));
              });
              const network = (async () => {
                const response = await fetchImpl(provider.base + path, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', ...(provider.key ? { Authorization: `Bearer ${provider.key}` } : {}) },
                  body: JSON.stringify({ model: provider.model, messages, max_tokens: 384, stream: false }),
                  signal: attemptSignal, redirect: 'error'
                });
                // An abandoned mock/transport must not mutate cooldown state later.
                attemptSignal.throwIfAborted();
                if (!response.ok) {
                  if ([402, 429].includes(response.status))
                    cooldown[provider.id] = now() + retryAfterMs(response.headers?.get('retry-after'), now());
                  else if ([401, 403].includes(response.status)) cooldown[provider.id] = now() + 60000;
                  throw error('Provider unavailable.', 503, { providerStatus: response.status });
                }
                const reply = provider.id === 'pollinations' && path === '/'
                  ? await response.text() : (await response.json()).choices?.[0]?.message?.content;
                attemptSignal.throwIfAborted();
                return parseReply(reply);
              })();
              const parsed = await Promise.race([network, aborted]);
              if (finished) return;
              if (provider.id === 'pollinations') cooldown.pollinations = now() + 30000;
              safeLog({ event: 'free_ai', provider: provider.id, endpoint: path, model: provider.model, status: 'ok', elapsedMs: Date.now() - attemptStarted, totalMs: Date.now() - started });
              finish(parsed);
              return;
            } catch (cause) {
              if (finished || signal?.aborted) return;
              safeLog({ event: 'free_ai', provider: provider.id, endpoint: path, status: cause.providerStatus || cause.status || 'network_error', elapsedMs: Date.now() - attemptStarted });
              // Never evade a host's quota/auth policy by switching paths.
              if ([401, 402, 403, 429].includes(cause.providerStatus)) return;
            } finally {
              clearTimeout(timer);
              attemptSignal.removeEventListener('abort', abortListener);
              controller.abort();
            }
          }
          if (!finished) cooldown[provider.id] = Math.max(cooldown[provider.id], now() + 5000);
        } finally {
          active[provider.id] = false;
        }
      }
      function launch() {
        clearTimeout(hedge);
        if (finished) return;
        if (next >= candidates.length) { if (!running) finish(graceful()); return; }
        const provider = candidates[next++];
        running++;
        request(provider).catch(() => {}).finally(() => {
          running--;
          if (!finished) launch(); // Immediate failover on error, no sleep/backoff.
        });
        // Hedge independent providers while a cold/slow primary is still running.
        if (next < candidates.length) hedge = setTimeout(launch, Math.min(4000, Math.max(0, hedgeMs)));
      }
      if (combined.aborted) onAbort(); else launch();
    });
  };
}

export const freeBrain = createFreeBrain();

export function isFreeFallbackError(cause) {
  if (cause?.name === 'AbortError' || cause?.status === 403) return false;
  return [401, 402, 429, 503, 504].includes(cause?.providerStatus || cause?.status) || cause?.name === 'TimeoutError' || /Provider request rejected \((401|402|429)\)|not configured/i.test(cause?.message || '');
}
