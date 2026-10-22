const $ = id => document.getElementById(id);
const el = (tag, text, cls) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = String(text); if (cls) node.className = cls; return node; };
const storageKey = 'jarvis.records.v1';
let records = [], localAudit = [], history = [], current = null, recognition = null, listening = false, stopped = false, prepared = null, voiceTimer, dragPanel;
try { const data = JSON.parse(localStorage.getItem(storageKey) || '[]'); if (Array.isArray(data)) records = data.filter(r => r && typeof r.title === 'string' && typeof r.id === 'string').slice(-300); } catch {}
const uid = () => crypto.randomUUID();
function setState(state, caption) {
  $('reactor').dataset.state = state; document.body.dataset.state = state;
  $('state-label').textContent = state.toUpperCase();
  $('reactor-caption').textContent = caption || ({ idle: 'Tap reactor to speak', listening: 'Listening · tap to interrupt', thinking: 'Independent workers active', speaking: 'Tap to interrupt', stopped: 'Stopped · send a command to resume' })[state];
  $('mic').textContent = listening ? 'STOP MIC' : 'MIC';
}
function addMessage(role, text) {
  const article = el('article', undefined, `message ${role}`);
  article.append(el('span', role === 'user' ? 'YOU' : 'JARVIS', 'speaker'), el('p', text));
  $('messages').append(article);
  while ($('messages').children.length > 50) $('messages').firstChild.remove();
  $('messages').scrollTop = $('messages').scrollHeight;
}
function audit(tool, status, detail) {
  const record = { id: uid(), at: new Date().toISOString(), tool, status, detail };
  localAudit.unshift(record); localAudit = localAudit.slice(0, 100); renderAudit();
}
function renderAudit() {
  $('audit').replaceChildren();
  for (const record of localAudit.slice(0, 60)) {
    const row = el('div', undefined, 'audit-row');
    row.append(el('time', new Date(record.at).toLocaleTimeString()), el('b', record.tool), el('span', record.status, `tag ${record.status === 'verified' ? 'cyan' : 'gold'}`), el('p', record.detail));
    $('audit').append(row);
  }
  if (!localAudit.length) $('audit').append(el('p', 'No tools executed yet.', 'muted'));
}
function safeLink(value, label) {
  try { const url = new URL(value); if (url.protocol !== 'https:' && url.protocol !== 'http:') return el('span', label || value); const a = el('a', label || url.hostname); a.href = url.href; a.target = '_blank'; a.rel = 'noopener noreferrer'; return a; } catch { return el('span', label || 'Source unavailable'); }
}
async function status() {
  try {
    const response = await fetch('/api/status'); if (!response.ok) throw new Error('Health unavailable');
    const data = await response.json();
    $('connection').textContent = 'SYSTEM ONLINE'; $('engine').textContent = data.engine;
    $('hubs').replaceChildren();
    for (const hub of data.capabilities) {
      const row = el('div', undefined, 'hub');
      row.append(el('b', hub.name), el('span', hub.mode, 'muted'), el('small', hub.permission));
      $('hubs').append(row);
    }
    $('google-connect').hidden = !data.googleConfigured || data.googleConnected;
    $('google-disconnect').hidden = !data.googleConnected;
    $('google-note').textContent = data.googleConnected ? 'Google session connected. Calendar and Gmail use read-only OAuth access. Sessions expire and are lost on server restart.' : data.googleConfigured ? 'Google OAuth configured; connect your account to activate real calendar and inbox access.' : 'Google OAuth is not configured. Calendar and Gmail are unconnected; add your own OAuth credentials in Render to activate them.';
    if (data.audit?.length) {
      const known = new Set(localAudit.map(a => a.id));
      localAudit = [...data.audit.filter(a => !known.has(a.id)).reverse(), ...localAudit].slice(0, 100); renderAudit();
    }
    return data;
  } catch { $('connection').textContent = 'CONNECTION UNAVAILABLE'; $('engine').textContent = 'Server unavailable · local memory remains accessible'; }
}
function persist() {
  try { localStorage.setItem(storageKey, JSON.stringify(records.slice(-300))); } catch { addMessage('assistant', 'Local storage is unavailable or full. This record will not survive a reload.'); }
  renderRecords();
}
function saveRecord(type, title, detail = '') {
  const record = { id: uid(), type, title: title.slice(0, 160), detail: detail.slice(0, 2000), created: new Date().toISOString(), updated: new Date().toISOString(), done: false, checkpoints: [] };
  records.push(record); records = records.slice(-300); persist(); audit('memory.save', 'verified', `${type} stored locally: ${record.title}`); return record;
}
function recordCard(record) {
  const card = el('article', undefined, 'record');
  card.append(el('span', record.type.toUpperCase(), 'micro-label'), el('h3', record.title), el('p', record.detail || (record.start ? new Date(record.start).toLocaleString() : ''), 'muted'));
  const actions = el('div', undefined, 'record-actions');
  if (record.type === 'task' || record.type === 'project') {
    const toggle = el('button', record.done ? 'Reopen' : 'Mark complete'); toggle.onclick = () => { record.done = !record.done; record.updated = new Date().toISOString(); persist(); audit('record.status', 'verified', `${record.title}: ${record.done ? 'completed' : 'open'}`); }; actions.append(toggle);
    card.append(el('span', record.done ? 'COMPLETE' : 'IN PROGRESS', 'tag'));
  }
  const edit = el('button', 'Edit'); edit.onclick = () => {
    const title = prompt('Record title', record.title); if (title === null || !title.trim()) return;
    const detail = prompt('Record details', record.detail || ''); if (detail === null) return;
    record.title = title.trim().slice(0, 160); record.detail = detail.slice(0, 2000); record.updated = new Date().toISOString(); persist(); audit('memory.edit', 'verified', record.title);
  }; actions.append(edit);
  if (record.type === 'project') {
    const checkpoint = el('button', '+ Checkpoint'); checkpoint.onclick = () => { const text = prompt('Checkpoint / next step'); if (!text?.trim()) return; record.checkpoints ||= []; record.checkpoints.push({ text: text.slice(0, 200), at: new Date().toISOString() }); record.updated = new Date().toISOString(); persist(); audit('project.checkpoint', 'verified', record.title); }; actions.append(checkpoint);
    for (const point of record.checkpoints || []) card.append(el('p', `• ${point.text} · ${new Date(point.at).toLocaleDateString()}`, 'muted'));
  }
  const remove = el('button', 'Delete', 'danger-text'); remove.onclick = () => { if (!confirm(`Delete local record “${record.title}”?`)) return; records = records.filter(r => r.id !== record.id); persist(); audit('memory.delete', 'verified', record.title); }; actions.append(remove); card.append(actions); return card;
}
function renderRecords() {
  $('records').replaceChildren(); $('local-events').replaceChildren();
  for (const record of [...records].reverse()) (record.type === 'calendar' ? $('local-events') : $('records')).append(recordCard(record));
  if (!$('records').children.length) $('records').append(el('p', 'No stored records. Say “remember I prefer concise answers”, “add task review plans” or “project launch prototype”.', 'muted'));
  if (!$('local-events').children.length) $('local-events').append(el('p', 'No browser-local events.', 'muted'));
}
$('record-form').onsubmit = event => { event.preventDefault(); saveRecord($('record-type').value, $('record-title').value.trim(), $('record-detail').value); $('record-title').value = ''; $('record-detail').value = ''; };
$('event-form').onsubmit = event => {
  event.preventDefault(); const date = new Date($('event-start').value); if (!Number.isFinite(date.getTime())) return;
  records.push({ id: uid(), type: 'calendar', title: $('event-title').value.trim(), start: date.toISOString(), created: new Date().toISOString(), detail: '', checkpoints: [] }); persist(); audit('calendar.local.add', 'verified', 'Event saved in browser-local calendar only.'); $('event-form').reset();
};
$('export-memory').onclick = () => {
  const blob = new Blob([JSON.stringify({ app: 'Jarvis', version: 1, records }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob), a = el('a'); a.href = url; a.download = 'jarvis-memory.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); audit('memory.export', 'verified', 'Local JSON export prepared.');
};
$('clear-memory').onclick = () => $('confirm-clear').showModal();
$('confirm-clear').onclose = () => { if ($('confirm-clear').returnValue === 'delete') { records = []; persist(); audit('memory.clear', 'verified', 'Local records deleted.'); } };
function prepareAction(value) {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Use a public HTTPS URL with no embedded credentials.');
    prepared = url.href; $('prepared-action').replaceChildren(el('p', prepared));
    const button = el('button', 'REVIEW & APPROVE', 'primary'); button.onclick = () => { $('confirm-destination').textContent = prepared; $('confirm-action').showModal(); };
    $('prepared-action').append(button); audit('navigation.prepare', 'verified', `Prepared only: ${prepared}`); $('action-panel').focus(); return `Navigation prepared: ${prepared}. Review and approve in the Action Preparation panel. Nothing has opened yet.`;
  } catch (error) { return error.message; }
}
$('action-form').onsubmit = event => { event.preventDefault(); addMessage('assistant', prepareAction($('action-url').value)); };
$('approve-action').onclick = () => {
  if (!prepared) return;
  window.open(prepared, '_blank', 'noopener,noreferrer');
  audit('navigation.execute', 'unverified', `User approved open request: ${prepared}. Destination load not verified.`); prepared = null; $('prepared-action').textContent = 'Navigation requested. Destination loading is not verified by Jarvis.';
};
function stopSpeech() { clearTimeout(voiceTimer); window.speechSynthesis?.cancel(); }
function stopListening() { try { recognition?.abort(); } catch {} listening = false; }
function emergencyStop() {
  stopped = true; $('handsfree').checked = false; current?.abort(); current = null; stopListening(); stopSpeech(); prepared = null; $('prepared-action').textContent = 'Prepared action cancelled.'; $('confirm-action').close('cancel'); setState('stopped'); $('mission-status').textContent = 'STOPPED';
  audit('emergency.stop', 'verified', 'Client requests, voice and prepared navigation stopped. Completed actions cannot be undone.');
  fetch('/api/stop', { method: 'POST' }).then(() => status()).catch(() => audit('emergency.stop.server', 'unverified', 'Server stop could not be confirmed. Client stopped locally.'));
}
$('stop').onclick = emergencyStop;
function loadVoices() {
  const selected = $('voice').value; $('voice').replaceChildren(el('option', 'System default'));
  $('voice').firstChild.value = '';
  for (const voice of window.speechSynthesis?.getVoices() || []) { const option = el('option', `${voice.name} (${voice.lang})`); option.value = voice.voiceURI; $('voice').append(option); }
  $('voice').value = selected;
}
if (window.speechSynthesis) { loadVoices(); window.speechSynthesis.onvoiceschanged = loadVoices; }
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
if (SpeechRecognition) {
  recognition = new SpeechRecognition(); recognition.lang = navigator.language || 'en-US'; recognition.continuous = false; recognition.interimResults = true;
  $('voice-status').textContent = 'READY · MIC PERMISSION REQUIRED';
  recognition.onstart = () => { listening = true; setState('listening'); };
  recognition.onresult = event => {
    let final = '', partial = '';
    for (let i = event.resultIndex; i < event.results.length; i++) { const text = event.results[i][0].transcript; if (event.results[i].isFinal) final += text; else partial += text; }
    $('transcript').textContent = final || partial;
    if (final.trim()) { stopListening(); const text = final.replace(/^\s*(?:hey\s+)?jarvis[,\s]*/i, '').trim(); if (/^(?:stop|emergency stop|abort|cancel everything)$/i.test(text)) emergencyStop(); else send(text); }
  };
  recognition.onerror = event => {
    listening = false;
    if (['not-allowed', 'service-not-allowed', 'audio-capture'].includes(event.error)) { $('handsfree').checked = false; $('voice-status').textContent = `MIC UNAVAILABLE: ${event.error}`; addMessage('assistant', 'Microphone unavailable. Allow microphone access in a supported browser, or use typed chat.'); }
    if (!current) setState(stopped ? 'stopped' : 'idle');
  };
  recognition.onend = () => { listening = false; if (!current && !window.speechSynthesis?.speaking && !stopped) setState('idle'); scheduleListening(); };
} else { $('voice-status').textContent = 'SPEECH INPUT UNSUPPORTED · TYPE INSTEAD'; $('mic').disabled = true; $('handsfree').disabled = true; }
function scheduleListening() { clearTimeout(voiceTimer); if ($('handsfree').checked && !current && !stopped && !window.speechSynthesis?.speaking) voiceTimer = setTimeout(startListening, 600); }
function startListening() {
  if (!recognition || listening) return;
  stopped = false; stopSpeech(); current?.abort(); current = null;
  try { recognition.start(); } catch { $('voice-status').textContent = 'VOICE BUSY · TRY AGAIN'; }
}
function toggleMic() { if (listening) { $('handsfree').checked = false; stopListening(); setState('idle'); } else startListening(); }
$('reactor').onclick = toggleMic; $('mic').onclick = toggleMic;
$('interrupt').onclick = () => { $('handsfree').checked = false; stopSpeech(); stopListening(); current?.abort(); current = null; setState('idle'); audit('voice.interrupt', 'verified', 'Speech and pending response interrupted.'); };
$('handsfree').onchange = () => { if ($('handsfree').checked) startListening(); else stopListening(); };
$('speak').onchange = () => { if (!$('speak').checked) { stopSpeech(); setState('idle'); scheduleListening(); } };
function speak(text) {
  if (!$('speak').checked || !window.speechSynthesis) { setState('idle'); scheduleListening(); return; }
  stopListening(); stopSpeech(); const utterance = new SpeechSynthesisUtterance(text.slice(0, 2200));
  utterance.voice = speechSynthesis.getVoices().find(v => v.voiceURI === $('voice').value) || null; utterance.rate = 1; utterance.pitch = 0.95;
  utterance.onend = utterance.onerror = () => { if (!stopped && !current) { setState('idle'); scheduleListening(); } };
  setState('speaking'); speechSynthesis.speak(utterance);
}
function localCommand(message) {
  const memory = message.match(/^remember\s+(.+)/i);
  if (memory) { saveRecord(/prefer/i.test(memory[1]) ? 'preference' : 'fact', memory[1]); return 'Saved to browser-local memory. It persists on this device, not across accounts.'; }
  const task = message.match(/^(?:add\s+)?task\s+(.+)/i); if (task) { saveRecord('task', task[1]); return 'Task saved locally.'; }
  const project = message.match(/^(?:add\s+)?project\s+(.+)/i); if (project) { saveRecord('project', project[1]); return 'Project registered locally. Add checkpoints in Memory & Projects.'; }
  if (/^(?:show|list|recall)\s+(?:my\s+)?(?:memory|memories|projects|tasks)/i.test(message)) return records.length ? records.filter(r => r.type !== 'calendar').map(r => `${r.type}: ${r.title}${r.detail ? ' — ' + r.detail : ''}`).join('\n') : 'No local memories or projects yet.';
  const navigation = message.match(/^(?:open|navigate to|prepare navigation to)\s+(https:\/\/\S+)/i); if (navigation) return prepareAction(navigation[1]);
  return null;
}
function showPlan(message) {
  const names = [];
  if (/calendar|schedule|agenda/i.test(message)) names.push('calendar'); if (/email|gmail|inbox|mailbox/i.test(message)) names.push('gmail'); if (/research|search|look up|investigate|web/i.test(message)) names.push('research'); if (/calculate|compute|\bcalc\b|simulate/i.test(message)) names.push('engineering'); if (/health|telemetry|system status/i.test(message)) names.push('telemetry');
  $('missions').replaceChildren();
  for (const name of names) { const worker = el('div', undefined, 'worker'); worker.append(el('b', name.toUpperCase()), el('span', 'RUNNING', 'tag cyan')); $('missions').append(worker); }
  if (!names.length) $('missions').append(el('p', 'Conversation / local command processing', 'muted'));
  $('mission-status').textContent = names.length > 1 ? `${names.length} PARALLEL WORKERS` : 'PROCESSING';
}
function showResults(data) {
  $('missions').replaceChildren();
  for (const result of data.results) {
    const worker = el('div', undefined, 'worker'); worker.append(el('b', result.tool.toUpperCase()), el('span', result.status.toUpperCase(), `tag ${result.status === 'verified' ? 'cyan' : 'gold'}`), el('p', result.text, 'muted')); $('missions').append(worker);
    if (result.audit) localAudit.unshift(result.audit);
    if (result.tool === 'research') {
      $('sources').replaceChildren(el('p', `Fetched ${result.retrievedAt || 'now'} · source records are unverified claims`, 'muted'));
      for (const source of result.sources || []) { const article = el('article', undefined, 'source'); article.append(el('span', source.provider, 'micro-label'), safeLink(source.url, source.title), el('p', source.excerpt, 'muted'), el('span', 'UNVERIFIED CLAIM', 'tag gold')); $('sources').append(article); }
      for (const error of result.errors || []) $('sources').append(el('p', error, 'muted'));
    }
    if (result.tool === 'calendar') {
      $('live-calendar').replaceChildren(el('p', result.text, 'muted'));
      for (const event of result.events || []) { const card = el('div', undefined, 'record'); card.append(safeLink(event.url, event.title), el('p', `Start: ${event.start} · End: ${event.end}${event.timeZone ? ' · ' + event.timeZone : ''}`, 'muted')); $('live-calendar').append(card); }
      if (records.some(r => r.type === 'calendar')) $('live-calendar').append(el('p', 'Local calendar records are below. They were not retrieved from Google.', 'muted'));
    }
    if (result.tool === 'gmail') {
      $('mail').replaceChildren(el('p', result.text, 'muted'));
      for (const item of result.messages || []) { const card = el('article', undefined, 'record'); card.append(el('b', item.subject || '(No subject)'), el('p', `${item.from} · ${item.date}`, 'muted')); $('mail').append(card); }
    }
  }
  $('mission-status').textContent = data.results.some(r => ['failed', 'unconfigured'].includes(r.status)) ? 'PARTIAL / SEE STATUS' : 'COMPLETE';
  $('engine').textContent = data.engine; renderAudit();
}
async function send(message) {
  if (!message?.trim()) return;
  if (/^(?:emergency stop|stop|abort|cancel everything)$/i.test(message.trim())) { emergencyStop(); return; }
  current?.abort(); stopListening(); stopSpeech(); stopped = false;
  addMessage('user', message); $('command').value = ''; $('transcript').textContent = message; setState('thinking');
  const localReply = localCommand(message);
  if (localReply !== null) { current = null; addMessage('assistant', localReply); history.push({ role: 'user', content: message }, { role: 'assistant', content: localReply }); history = history.slice(-12); speak(localReply); return; }
  const controller = new AbortController(); current = controller; showPlan(message);
  try {
    const response = await fetch('/api/mission', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message, history }), signal: controller.signal });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Mission failed.');
    if (current !== controller || stopped) return;
    showResults(data); addMessage('assistant', data.reply); history.push({ role: 'user', content: message }, { role: 'assistant', content: data.reply }); history = history.slice(-12); current = null; speak(data.reply);
  } catch (error) {
    if (current !== controller) return;
    current = null; if (error.name !== 'AbortError' && !stopped) { addMessage('assistant', error.message); audit('mission', 'failed', error.message); }
    setState(stopped ? 'stopped' : 'idle'); $('mission-status').textContent = 'STOPPED / FAILED'; scheduleListening();
  }
}
$('command-form').onsubmit = event => { event.preventDefault(); send($('command').value.trim()); };
for (const button of document.querySelectorAll('[data-command]')) button.onclick = () => send(button.dataset.command);
for (const button of document.querySelectorAll('[data-focus]')) button.onclick = () => { $(button.dataset.focus).scrollIntoView({ behavior: 'smooth', block: 'center' }); $(button.dataset.focus).focus(); };
$('google-disconnect').onclick = async () => { try { const response = await fetch('/api/disconnect', { method: 'POST' }); if (!response.ok) throw new Error('Disconnect failed'); addMessage('assistant', 'Google session disconnected.'); await status(); } catch (error) { addMessage('assistant', error.message); } };
for (const header of document.querySelectorAll('.panel-head')) {
  header.addEventListener('dragstart', event => { dragPanel = header.closest('.panel'); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', dragPanel.id); });
  header.addEventListener('dragend', () => { dragPanel = null; });
}
for (const panel of document.querySelectorAll('.panel')) {
  panel.addEventListener('dragover', event => { if (dragPanel && panel !== dragPanel) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; } });
  panel.addEventListener('drop', event => { event.preventDefault(); if (!dragPanel || panel === dragPanel) return; $('workspace').insertBefore(dragPanel, panel); try { localStorage.setItem('jarvis.layout.v1', JSON.stringify([...$('workspace').children].map(p => p.id))); } catch {} });
}
try { for (const id of JSON.parse(localStorage.getItem('jarvis.layout.v1') || '[]')) { const panel = $(id); if (panel?.classList.contains('panel')) $('workspace').append(panel); } } catch {}
function clock() { $('clock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
clock(); setInterval(clock, 1000); renderRecords(); renderAudit(); setState('idle'); status();
document.addEventListener('visibilitychange', () => { if (document.hidden) { $('handsfree').checked = false; stopListening(); } });
window.addEventListener('keydown', event => { if (event.key === 'Escape') emergencyStop(); });
