// Text-only free-provider chain. No key or private prompt is ever put in a URL.
// Optional distinct fallback: GROQ_API_KEY (Groq free-tier account),
// GROQ_FREE_MODEL defaults to llama-3.1-8b-instant. Keys stay server-side.
const error = (message, status = 503, extra = {}) => Object.assign(new Error(message), { status, ...extra });

export function retryAfterMs(value, now = Date.now()) {
  if (typeof value !== 'string' || !value.trim()) return 60000;
  const seconds = Number(value);
  const duration = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : Date.parse(value) - now;
  // Do not cap a provider's Retry-After: a long cooldown must remain honored.
  return Number.isFinite(duration) ? Math.max(1000, duration) : 60000;
}

function parseReply(reply) {
  if (typeof reply !== 'string' || !reply.trim() || /^\s*(?:<!doctype|<html)/i.test(reply))
    throw error('Free AI returned no readable answer.', 502);
  let parsed;
  try { parsed = JSON.parse(reply.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')); }
  catch { parsed = { reply, tool: null }; }
  if (!parsed || typeof parsed.reply !== 'string' || !parsed.reply.trim())
    throw error('Free AI returned an invalid response.', 502);
  return parsed;
}

// Isolated provider state also makes cooldown/concurrency behavior testable.
export function createFreeBrain({ env = process.env, now = Date.now } = {}) {
  const cooldown = { pollinations: 0, groq: 0 };
  const active = { pollinations: false, groq: false };
  return async function generate({ prompt, system = '', image, signal, model = 'openai-fast', fetchImpl = fetch, timeoutMs = 9000, attemptMs = 4500, log = console.warn }) {
    if (image) throw error('Free AI is text-only. Select a configured vision provider.');
    signal?.throwIfAborted();
    const started = Date.now();
    const budget = Math.min(9000, Math.max(1, timeoutMs));
    const messages = [{ role: 'system', content: system }, { role: 'user', content: prompt }];
    const groqKey = env.GROQ_API_KEY;
    // With Groq configured, reserve the second attempt for a distinct provider.
    const providers = [
      { id: 'pollinations', base: 'https://text.pollinations.ai', paths: groqKey ? ['/openai'] : ['/openai', '/'], model },
      ...(groqKey ? [{ id: 'groq', base: 'https://api.groq.com', paths: ['/openai/v1/chat/completions'], model: env.GROQ_FREE_MODEL || 'llama-3.1-8b-instant', key: groqKey }] : [])
    ];
    let last, waiting = false;
    for (const provider of providers) {
      signal?.throwIfAborted();
      if (now() < cooldown[provider.id] || active[provider.id]) { waiting = true; continue; }
      for (const path of provider.paths) {
        signal?.throwIfAborted();
        const remaining = budget - (Date.now() - started);
        if (remaining <= 0) break;
        const controller = new AbortController();
        const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
        const attemptStarted = Date.now();
        let timer, onAbort;
        active[provider.id] = true;
        try {
          const aborted = new Promise((_, reject) => {
            onAbort = () => reject(combined.reason || error('Free AI request cancelled.', 499));
            combined.addEventListener('abort', onAbort, { once: true });
            if (combined.aborted) onAbort();
            timer = setTimeout(() => controller.abort(error('Free AI timed out. Please retry or select another provider.', 504)), Math.min(attemptMs, remaining));
          });
          const request = (async () => {
            const response = await fetchImpl(provider.base + path, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...(provider.key ? { Authorization: `Bearer ${provider.key}` } : {}) },
              body: JSON.stringify({ model: provider.model, messages, max_tokens: 768, stream: false }),
              signal: combined, redirect: 'error'
            });
            if (!response.ok) {
              if ([402, 429].includes(response.status)) {
                cooldown[provider.id] = now() + retryAfterMs(response.headers?.get('retry-after'), now());
              } else if ([401, 403].includes(response.status)) {
                cooldown[provider.id] = now() + 60000;
              }
              // Do not expose upstream bodies, credentials, or raw rejection text.
              throw error('Free AI is temporarily unavailable. Please retry shortly or select another provider.', 503, { providerStatus: response.status });
            }
            const reply = provider.id === 'pollinations' && path === '/'
              ? await response.text() : (await response.json()).choices?.[0]?.message?.content;
            return parseReply(reply);
          })();
          const parsed = await Promise.race([request, aborted]);
          // Anonymous Classic permits only one request per IP every 30 seconds.
          if (provider.id === 'pollinations') cooldown.pollinations = now() + 30000;
          log(JSON.stringify({ event: 'free_ai', provider: provider.id, endpoint: path, model: provider.model, status: 'ok', elapsedMs: Date.now() - attemptStarted, totalMs: Date.now() - started }));
          return parsed;
        } catch (cause) {
          last = cause;
          log(JSON.stringify({ event: 'free_ai', provider: provider.id, endpoint: path, model: provider.model, status: cause.providerStatus || cause.status || cause.name || 'network_error', elapsedMs: Date.now() - attemptStarted, totalMs: Date.now() - started }));
          if (signal?.aborted) throw signal.reason || cause;
          // Another path on the same host cannot evade its limit or auth policy.
          if ([401, 402, 403, 429].includes(cause.providerStatus)) { waiting = true; break; }
        } finally {
          clearTimeout(timer);
          combined.removeEventListener('abort', onAbort);
          controller.abort();
          active[provider.id] = false;
        }
      }
    }
    signal?.throwIfAborted();
    if (waiting) {
      const availableAt = Math.min(...providers.map(p => active[p.id] ? now() + 30000 : cooldown[p.id]).filter(t => t > now()));
      const retryAfterSeconds = Math.max(1, Math.ceil(((Number.isFinite(availableAt) ? availableAt : now() + 30000) - now()) / 1000));
      return { reply: `Free AI is temporarily busy. Please try again in ${retryAfterSeconds} seconds or choose a configured provider.`, tool: null, unavailable: true, retryAfterSeconds };
    }
    throw last?.status ? last : error('Free AI is temporarily unavailable. Please retry shortly.', 503);
  };
}

export const freeBrain = createFreeBrain();

export function isFreeFallbackError(cause) {
  if (cause?.name === 'AbortError' || cause?.status === 403) return false;
  return [401, 402, 429, 503, 504].includes(cause?.providerStatus || cause?.status) || cause?.name === 'TimeoutError' || /Provider request rejected \((401|402|429)\)|not configured/i.test(cause?.message || '');
}
