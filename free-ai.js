// Keyless, text-only provider. Never pass a paid-provider key to this service.
const error = (message, status = 503) => Object.assign(new Error(message), { status });
export async function freeBrain({ prompt, system = '', image, signal, model = 'openai', fetchImpl = fetch }) {
  if (image) throw error('Free AI is text-only. Select a configured vision provider.');
  const timed = signal ? AbortSignal.any([signal, AbortSignal.timeout(25000)]) : AbortSignal.timeout(25000);
  let reply;
  try {
    const response = await fetchImpl('https://text.pollinations.ai/openai/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }], max_tokens: 2400 }),
      signal: timed,
      redirect: 'error'
    });
    if (!response.ok) throw error('Free AI chat endpoint unavailable.');
    reply = (await response.json()).choices?.[0]?.message?.content;
    if (typeof reply !== 'string' || !reply.trim()) throw error('Free AI returned no readable answer.', 502);
  } catch (cause) {
    if (timed.aborted) throw cause;
    // The public text endpoint is a compatibility fallback, not a simulated reply.
    const context = prompt.length > 6000 ? '[Context truncated; omitted facts are unknown.]\n' + prompt.slice(0, 6000) : prompt;
    const response = await fetchImpl('https://text.pollinations.ai/' + encodeURIComponent(system + '\n' + context) + '?model=' + encodeURIComponent(model), { signal: timed, redirect: 'error' });
    if (!response.ok) throw error('Free AI is temporarily unavailable. Please retry shortly.');
    reply = await response.text();
  }
  if (typeof reply !== 'string' || !reply.trim()) throw error('Free AI returned no readable answer.', 502);
  let parsed;
  try { parsed = JSON.parse(reply.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')); }
  catch { parsed = { reply, tool: null }; }
  if (typeof parsed.reply !== 'string' || !parsed.reply.trim()) throw error('Free AI returned an invalid response.', 502);
  return parsed;
}

export function isFreeFallbackError(cause) {
  if (cause?.name === 'AbortError' || cause?.status === 403) return false;
  return [401, 429, 503].includes(cause?.providerStatus || cause?.status) || /Provider request rejected \((401|429)\)|not configured/i.test(cause?.message || '');
}
