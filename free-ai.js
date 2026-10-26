// Keyless, text-only provider. Never pass a paid-provider key to this service.
const error = (message, status = 503, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const endpoint = 'https://text.pollinations.ai';
let cooldownUntil = 0;

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

export async function freeBrain({ prompt, system = '', image, signal, model = 'openai-fast', fetchImpl = fetch, timeoutMs = 9000, attemptMs = 4500, log = console.warn }) {
  if (image) throw error('Free AI is text-only. Select a configured vision provider.');
  signal?.throwIfAborted();
  if (Date.now() < cooldownUntil) throw error('Free AI is rate limited. Please retry in a minute.', 503);
  const started = Date.now();
  const budget = Math.min(9000, Math.max(1, timeoutMs));
  // Do not put private conversation context in a GET URL. Both routes accept messages.
  const body = JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }], max_tokens: 768, stream: false });
  let last;
  for (const path of ['/openai', '/']) {
    signal?.throwIfAborted();
    const remaining = budget - (Date.now() - started);
    if (remaining <= 0) break;
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const attemptStarted = Date.now();
    let timer, onAbort;
    try {
      // Race the entire operation, including response body reading, not only headers.
      const aborted = new Promise((_, reject) => {
        onAbort = () => reject(combined.reason || error('Free AI request cancelled.', 499));
        combined.addEventListener('abort', onAbort, { once: true });
        if (combined.aborted) onAbort();
        timer = setTimeout(() => controller.abort(error('Free AI timed out. Please retry or select another provider.', 504)), Math.min(attemptMs, remaining));
      });
      const request = (async () => {
        const response = await fetchImpl(endpoint + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: combined, redirect: 'error' });
        if (!response.ok) {
          if ([402, 403, 429].includes(response.status)) {
            const retry = Number(response.headers?.get('retry-after'));
            cooldownUntil = Date.now() + Math.min(300000, Math.max(30000, Number.isFinite(retry) ? retry * 1000 : 60000));
          }
          throw error(`Free AI endpoint rejected (${response.status}). Please retry later or select another provider.`, 503, { providerStatus: response.status });
        }
        const reply = path === '/openai' ? (await response.json()).choices?.[0]?.message?.content : await response.text();
        return parseReply(reply);
      })();
      const parsed = await Promise.race([request, aborted]);
      log(JSON.stringify({ event: 'free_ai', endpoint: path, model, status: 'ok', elapsedMs: Date.now() - attemptStarted, totalMs: Date.now() - started }));
      return parsed;
    } catch (cause) {
      last = cause;
      log(JSON.stringify({ event: 'free_ai', endpoint: path, model, status: cause.providerStatus || cause.status || cause.name || 'network_error', elapsedMs: Date.now() - attemptStarted, totalMs: Date.now() - started }));
      if (signal?.aborted) throw signal.reason || cause;
      // Switching paths cannot evade per-IP rate limits, auth requirements or blocks.
      if ([401, 402, 403, 429].includes(cause.providerStatus)) throw cause;
    } finally {
      clearTimeout(timer);
      combined.removeEventListener('abort', onAbort);
      controller.abort();
    }
  }
  throw last?.status ? last : error('Free AI is temporarily unavailable. Please retry shortly.', 503);
}

export function isFreeFallbackError(cause) {
  if (cause?.name === 'AbortError' || cause?.status === 403) return false;
  return [401, 429, 503, 504].includes(cause?.providerStatus || cause?.status) || cause?.name === 'TimeoutError' || /Provider request rejected \((401|429)\)|not configured/i.test(cause?.message || '');
}
