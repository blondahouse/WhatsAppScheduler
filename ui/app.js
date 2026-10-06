const legacyErrors = {"\u0420\u0435\u0437\u0443\u043b\u044c\u0442\u0430\u0442 \u043d\u0435 \u043f\u043e\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0451\u043d. \u0410\u0432\u0442\u043e\u043c\u0430\u0442\u0438\u0447\u0435\u0441\u043a\u0438\u0439 \u043f\u043e\u0432\u0442\u043e\u0440 \u043e\u0442\u043a\u043b\u044e\u0447\u0451\u043d, \u0447\u0442\u043e\u0431\u044b \u0438\u0437\u0431\u0435\u0436\u0430\u0442\u044c \u0434\u0443\u0431\u043b\u044f.": "The result is unconfirmed. Automatic retry is disabled to avoid a duplicate.", "\u0412\u0440\u0435\u043c\u044f \u0440\u0430\u0441\u043f\u0438\u0441\u0430\u043d\u0438\u044f \u043d\u0435 \u0441\u0443\u0449\u0435\u0441\u0442\u0432\u0443\u0435\u0442 \u0432 \u0442\u0435\u043a\u0443\u0449\u0435\u043c \u0447\u0430\u0441\u043e\u0432\u043e\u043c \u043f\u043e\u044f\u0441\u0435. \u0418\u0437\u043c\u0435\u043d\u0438\u0442\u0435 \u0434\u0430\u0442\u0443 \u0438 \u0432\u0440\u0435\u043c\u044f.": "The scheduled time does not exist in the current time zone. Change the date and time.", "\u0412\u0440\u0435\u043c\u044f \u043e\u0442\u043f\u0440\u0430\u0432\u043a\u0438 \u043f\u0440\u043e\u043f\u0443\u0449\u0435\u043d\u043e.": "The send time was missed.", "\u041f\u0440\u043e\u043f\u0443\u0449\u0435\u043d\u043e: \u0437\u0430\u0434\u0435\u0440\u0436\u043a\u0430 \u043f\u0440\u0435\u0432\u044b\u0448\u0430\u0435\u0442 \u0432\u044b\u0431\u0440\u0430\u043d\u043d\u044b\u0439 \u043f\u0440\u0435\u0434\u0435\u043b.": "Skipped: the delay exceeds the selected limit.", "\u041e\u0442\u043f\u0440\u0430\u0432\u043a\u0430 \u043d\u0435 \u043f\u043e\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043d\u0430. \u041f\u0440\u043e\u0432\u0435\u0440\u044c\u0442\u0435 WhatsApp. \u0410\u0432\u0442\u043e\u043c\u0430\u0442\u0438\u0447\u0435\u0441\u043a\u0438\u0439 \u043f\u043e\u0432\u0442\u043e\u0440 \u043e\u0442\u043a\u043b\u044e\u0447\u0451\u043d, \u0447\u0442\u043e\u0431\u044b \u0438\u0437\u0431\u0435\u0436\u0430\u0442\u044c \u0434\u0443\u0431\u043b\u044f.": "Sending is not confirmed. Check WhatsApp. Automatic retry is disabled to avoid a duplicate."};
const humanError = text => legacyErrors[text] || text;
const $ = id => document.getElementById(id);
let state, editing, formBusy = false;
const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const statusNames = { active:'Active', paused:'Paused', completed:'Completed', error:'Error' };
const resultNames = { sending:'Sending…', sent:'Sent', failed:'Error', uncertain:'Result unconfirmed', skipped:'Skipped' };
function element(tag, text, cls) { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; }
function recipientText(r) { r = state?.recipients.find(x => x.jid === r.jid && x.kind === r.kind) || r; return `${r.kind === 'group' ? 'Group' : 'Personal chat'} · ${r.name}`; }
function notice(text, error = false) { $('feedback').textContent = text; $('feedback').className = error ? 'error' : 'success'; $('feedback').hidden = false; }
async function call(action, payload) {
  const response = await window.waScheduler.call(action, payload);
  if (!response.ok) throw new Error(response.error);
  if (response.data) render(response.data);
  return response;
}
async function action(fn) { try { await fn(); } catch (e) { notice(e.message, true); } }
function button(text, fn, cls) { const b = element('button', text, cls); b.type = 'button'; b.addEventListener('click', () => action(async () => { b.disabled = true; try { await fn(); } finally { b.disabled = false; } })); return b; }
function render(next) {
  state = next;
  $('connection').textContent = state.connection; $('connection').className = `badge ${state.connection === 'WhatsApp connected' ? 'success' : ''}`;
  $('auth').hidden = ['WhatsApp connected','Signed out','Signing out…'].includes(state.connection);
  $('logout').disabled = state.connection !== 'WhatsApp connected';
  $('reconnect').textContent = state.connection === 'Signed out' ? 'Connect WhatsApp' : 'Reconnect';
  $('qr').hidden = !state.qr; $('qr-pending').hidden = !!state.qr;
  $('qr-pending').textContent = state.connection === 'Disconnected' ? 'The QR code will appear when WhatsApp is reachable.' : 'Requesting QR code…';
  if (state.qr) $('qr').src = state.qr;
  $('reconnect').hidden = state.connection === 'WhatsApp connected';
  $('reconnect').disabled = state.connection === 'Signing out…';
  $('app-version').textContent = state.version ? `v${state.version}` : '';
  $('connection-error').hidden = !state.connectionError; $('connection-error').textContent = state.connectionError;
  $('sync-note').textContent = state.syncNote || 'Your chats will appear after connecting.';
  $('refresh').disabled = state.connection !== 'WhatsApp connected' || !!state.refreshing;
  $('refresh').textContent = state.refreshing ? 'Refreshing…' : 'Refresh lists';
  $('paused').hidden = !state.settings.paused;
  $('autostart').checked = state.settings.autostart; $('global-paused').checked = state.settings.paused; $('grace').value = String(state.settings.grace);
  const list = $('schedule-list'); list.replaceChildren();
  if (!state.schedules.length) { const e = element('div', undefined, 'empty'); e.append(element('strong','No schedules yet'),element('span','Connect WhatsApp and create your first scheduled message.')); list.append(e); }
  for (const s of state.schedules) {
    const card = element('article', undefined, 'card'), top = element('div', undefined, 'card-top');
    top.append(element('span', recipientText(s.recipient), 'recipient-name'), element('span', statusNames[s.status], `badge ${s.status === 'completed' ? 'success' : s.status === 'error' ? 'error' : ''}`));
    const info = s.kind === 'once' ? `One-time · ${s.once.replace('T',' · ')}` : `Recurring · ${[1,2,3,4,5,6,0].filter(d => s.days.includes(d)).map(d => dayNames[d]).join(' · ')} · ${s.from}–${s.to} · every ${s.interval}`;
    card.append(top, element('p', s.text, 'message-preview'), element('div', info + (s.jitterMinutes ? ` · jitter ±${s.jitterMinutes} min (no zero)` : ''), 'card-info'));
    if (s.error) card.append(element('p', humanError(s.error), 'error small'));
    const actions = element('div', undefined, 'card-actions');
    const toggle = element('label', undefined, 'toggle-label'), input = element('input'); input.type = 'checkbox'; input.checked = s.enabled; input.disabled = s.status === 'completed'; input.setAttribute('aria-label',`Enable schedule for ${s.recipient.name}`);
    input.addEventListener('change', () => action(async () => { try { await call('toggle', s.id); } catch(e) { render(state); throw e; } })); toggle.append(input,element('span',s.enabled ? 'On' : 'Off'));
    actions.append(toggle, button('Edit', () => openEditor(s)), button('Send test', async () => { await call('test',{recipient:s.recipient,text:s.text}); notice('Test message sent.'); }),button('Delete', async () => { if (confirm(`Delete the schedule for “${s.recipient.name}”?`)) await call('delete',s.id); },'danger'));
    card.append(actions); list.append(card);
  }
  const history = $('history-list'); history.replaceChildren();
  if (!state.history.length) history.append(element('p','No messages sent yet.','empty'));
  for (const h of state.history) {
    const row = element('div',undefined,'history-row');
    row.append(element('span',new Date(h.at).toLocaleString(undefined,{dateStyle:'short',timeStyle:'short'})),element('span',recipientText(h.recipient)),element('span',resultNames[h.result],h.result === 'sent' ? 'success' : h.result === 'uncertain' || h.result === 'failed' ? 'error' : 'muted'));
    if (h.jitterOffset) row.append(element('span',`Scheduled for ${new Date(h.plannedAt).toLocaleString(undefined,{dateStyle:'short',timeStyle:'short'})} · jitter ${h.jitterOffset > 0 ? '+' : ''}${h.jitterOffset} min`,'history-error muted'));
    if (h.error) row.append(element('span',humanError(h.error),'history-error')); history.append(row);
  }
  if ($('editor').open) renderRecipients();
}
function renderRecipients(selected = $('recipient').value) {
  const kind = document.querySelector('input[name="recipient-kind"]:checked').value;
  const query = $('recipient-search').value.toLocaleLowerCase();
  $('recipient').replaceChildren(new Option('Choose a recipient',''));
  const rs = state.recipients.filter(r => r.kind === kind && (`${r.name} ${r.jid}`).toLocaleLowerCase().includes(query)).sort((a,b) => a.name.localeCompare(b.name));
  const counts = new Map(); for (const r of rs) counts.set(r.name,(counts.get(r.name)||0)+1);
  for (const r of rs) $('recipient').append(new Option(counts.get(r.name) > 1 ? `${r.name} · ${r.jid.split('@')[0]}` : r.name,r.jid));
  $('recipient').value = selected;
  $('recipient-note').textContent = rs.length ? '' : query ? 'No recipients match your search.' : kind === 'personal' ? 'Waiting for personal chats from your phone. Open WhatsApp on your phone and send or receive a message in the chat. It will appear here automatically.' : 'No groups available. Click Refresh lists.';
}
function showJitter() { const enabled = $('jitter-enabled').checked; $('jitter-field').hidden = !enabled; $('jitter-note').hidden = !enabled; }
function showKind() { const weekly = $('schedule-kind').value === 'weekly'; $('weekly-fields').hidden = !weekly; $('once-fields').hidden = weekly; }
function openEditor(s) {
  editing = s?.id; $('schedule-form').reset(); $('form-error').hidden = true; $('test-result').hidden = true;
  $('editor-title').textContent = s ? 'Edit schedule' : 'New schedule';
  document.querySelector(`input[name="recipient-kind"][value="${s?.recipient.kind || 'personal'}"]`).checked = true;
  $('recipient-search').value = ''; renderRecipients(s?.recipient.jid || ''); $('message').value = s?.text || '';
  $('schedule-kind').value = s?.kind || 'once';
  const d = new Date(Date.now()+3600000), pad = n => String(n).padStart(2,'0');
  const once = s?.once || `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  [$('once-date').value,$('once-time').value] = once.split('T');
  $('from').value = s?.from || '08:00'; $('to').value = s?.to || '08:00'; $('interval').value = s?.interval || '00:30';
  for (const input of $('weekdays').querySelectorAll('input')) input.checked = s?.days?.includes(Number(input.value)) || false;
  $('jitter-enabled').checked = !!s?.jitterMinutes; $('jitter-minutes').value = String(s?.jitterMinutes || 5);
  showJitter(); showKind(); $('editor').showModal();
}
function payload() {
  return { jitterMinutes:$('jitter-enabled').checked ? (/^\d+$/.test($('jitter-minutes').value) && Number($('jitter-minutes').value) >= 1 ? Number($('jitter-minutes').value) : -1) : 0, id:editing, recipient:state.recipients.find(r => r.jid === $('recipient').value), text:$('message').value,kind:$('schedule-kind').value,once:`${$('once-date').value}T${$('once-time').value}`,days:[...$('weekdays').querySelectorAll('input:checked')].map(i => Number(i.value)),from:$('from').value,to:$('to').value,interval:$('interval').value };
}
for (const day of [1,2,3,4,5,6,0]) { const label = element('label'), input = element('input'); input.type='checkbox'; input.value=String(day); label.append(input,dayNames[day]); $('weekdays').append(label); }
for (const tab of document.querySelectorAll('.tab')) tab.addEventListener('click',()=> { for(const t of document.querySelectorAll('.tab')) { t.classList.toggle('selected',t === tab); $(`${t.dataset.tab}-panel`).hidden = t !== tab; } });
$('logout').addEventListener('click',()=>action(async()=> {
  if (!confirm('Sign out of WhatsApp and unlink this device? Your schedules and history will be kept, and all schedules will be paused.')) return;
  $('logout').disabled=true;
  try { await call('logout'); notice('Signed out. Your schedules are saved and paused.'); }
  finally { $('logout').disabled=state.connection !== 'WhatsApp connected'; }
}));
$('copy-diagnostics').addEventListener('click',()=>action(async()=>{ await call('diagnostics');notice('Diagnostics copied. Paste the report into the support chat.'); }));
$('new').addEventListener('click',()=>openEditor());
$('jitter-enabled').addEventListener('change',showJitter);
$('schedule-kind').addEventListener('change',showKind);
$('recipient-search').addEventListener('input',()=>renderRecipients());
for(const input of document.querySelectorAll('input[name="recipient-kind"]')) input.addEventListener('change',()=> { $('recipient-search').value='';renderRecipients(''); });
for(const id of ['close-editor','cancel']) $(id).addEventListener('click',()=> { if(!formBusy) $('editor').close(); });
$('editor').addEventListener('cancel',event=> { if(formBusy) event.preventDefault(); });
$('reconnect').addEventListener('click',()=>action(async()=>{ $('reconnect').disabled=true; try { await call('connect'); } finally { $('reconnect').disabled=false; } }));
$('refresh').addEventListener('click',()=>action(async()=>{ $('refresh').disabled=true; try { await call('refresh'); notice(state.refreshResult || 'The refresh request finished.'); } finally { $('refresh').disabled=state.connection !== 'WhatsApp connected' || !!state.refreshing; } }));
$('save-settings').addEventListener('click',()=>action(async()=>{ await call('settings',{grace:Number($('grace').value),autostart:$('autostart').checked,paused:$('global-paused').checked});notice('Settings saved.'); }));
async function formAction(fn) {
  if(formBusy) return;
  formBusy=true; $('save').disabled=true; $('test').disabled=true; $('form-error').hidden=true; $('test-result').hidden=true;
  try { await fn(); } catch(e) { $('form-error').textContent=e.message; $('form-error').hidden=false; }
  finally { formBusy=false; $('save').disabled=false; $('test').disabled=false; }
}
$('test').addEventListener('click',()=>formAction(async()=> { const p=payload(); await call('test',{recipient:p.recipient,text:p.text}); $('test-result').textContent='Test message sent.'; $('test-result').className='success'; $('test-result').hidden=false; }));
$('schedule-form').addEventListener('submit',event=> {event.preventDefault();void formAction(async()=> { await call('save',payload());$('editor').close();notice('Schedule saved.'); });});
window.waScheduler.subscribe(render);
void action(()=>call('state'));
