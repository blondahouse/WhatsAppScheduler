const $ = id => document.getElementById(id);
let state, editing, formBusy = false;
const dayNames = ['Вс','Пн','Вт','Ср','Чт','Пт','Сб'];
const statusNames = { active:'Активно', paused:'Приостановлено', completed:'Выполнено', error:'Ошибка' };
const resultNames = { sending:'Отправляется…', sent:'Отправлено', failed:'Ошибка', uncertain:'Результат не подтверждён', skipped:'Пропущено' };
function element(tag, text, cls) { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; }
function recipientText(r) { return `${r.kind === 'group' ? 'Группа' : 'Личный чат'} · ${r.name}`; }
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
  $('connection').textContent = state.connection; $('connection').className = `badge ${state.connection === 'WhatsApp подключён' ? 'success' : ''}`;
  $('auth').hidden = !state.qr; if (state.qr) $('qr').src = state.qr;
  $('connection-error').hidden = !state.connectionError; $('connection-error').textContent = state.connectionError;
  $('sync-note').textContent = state.syncNote || 'Списки чатов появятся после подключения.';
  $('refresh').disabled = state.connection !== 'WhatsApp подключён';
  $('paused').hidden = !state.settings.paused;
  $('autostart').checked = state.settings.autostart; $('global-paused').checked = state.settings.paused; $('grace').value = String(state.settings.grace);
  const list = $('schedule-list'); list.replaceChildren();
  if (!state.schedules.length) { const e = element('div', undefined, 'empty'); e.append(element('strong','Пока нет расписаний'),element('span','Подключите WhatsApp и создайте первое сообщение.')); list.append(e); }
  for (const s of state.schedules) {
    const card = element('article', undefined, 'card'), top = element('div', undefined, 'card-top');
    top.append(element('span', recipientText(s.recipient), 'recipient-name'), element('span', statusNames[s.status], `badge ${s.status === 'completed' ? 'success' : s.status === 'error' ? 'error' : ''}`));
    const info = s.kind === 'once' ? `Одноразовое · ${s.once.replace('T',' · ')}` : `Повторяющееся · ${[1,2,3,4,5,6,0].filter(d => s.days.includes(d)).map(d => dayNames[d]).join(' · ')} · ${s.from}–${s.to} · каждые ${s.interval}`;
    card.append(top, element('p', s.text, 'message-preview'), element('div', info, 'card-info'));
    if (s.error) card.append(element('p', s.error, 'error small'));
    const actions = element('div', undefined, 'card-actions');
    const toggle = element('label', undefined, 'toggle-label'), input = element('input'); input.type = 'checkbox'; input.checked = s.enabled; input.disabled = s.status === 'completed'; input.setAttribute('aria-label',`Активность ${s.recipient.name}`);
    input.addEventListener('change', () => action(async () => { try { await call('toggle', s.id); } catch(e) { render(state); throw e; } })); toggle.append(input,element('span',s.enabled ? 'Включено' : 'Выключено'));
    actions.append(toggle, button('Редактировать', () => openEditor(s)), button('Отправить тест', async () => { await call('test',{recipient:s.recipient,text:s.text}); notice('Тестовое сообщение отправлено.'); }),button('Удалить', async () => { if (confirm(`Удалить расписание для «${s.recipient.name}»?`)) await call('delete',s.id); },'danger'));
    card.append(actions); list.append(card);
  }
  const history = $('history-list'); history.replaceChildren();
  if (!state.history.length) history.append(element('p','Отправок пока нет.','empty'));
  for (const h of state.history) {
    const row = element('div',undefined,'history-row');
    row.append(element('span',new Date(h.at).toLocaleString(undefined,{dateStyle:'short',timeStyle:'short'})),element('span',recipientText(h.recipient)),element('span',resultNames[h.result],h.result === 'sent' ? 'success' : h.result === 'uncertain' || h.result === 'failed' ? 'error' : 'muted'));
    if (h.error) row.append(element('span',h.error,'history-error')); history.append(row);
  }
  if ($('editor').open) renderRecipients();
}
function renderRecipients(selected = $('recipient').value) {
  const kind = document.querySelector('input[name="recipient-kind"]:checked').value;
  const query = $('recipient-search').value.toLocaleLowerCase();
  $('recipient').replaceChildren(new Option('Выберите получателя',''));
  const rs = state.recipients.filter(r => r.kind === kind && (`${r.name} ${r.jid}`).toLocaleLowerCase().includes(query)).sort((a,b) => a.name.localeCompare(b.name));
  const counts = new Map(); for (const r of rs) counts.set(r.name,(counts.get(r.name)||0)+1);
  for (const r of rs) $('recipient').append(new Option(counts.get(r.name) > 1 ? `${r.name} · ${r.jid.split('@')[0]}` : r.name,r.jid));
  $('recipient').value = selected;
  $('recipient-note').textContent = rs.length ? '' : 'Нет доступных чатов. Дождитесь синхронизации или нажмите «Обновить списки».';
}
function showKind() { const weekly = $('schedule-kind').value === 'weekly'; $('weekly-fields').hidden = !weekly; $('once-fields').hidden = weekly; }
function openEditor(s) {
  editing = s?.id; $('schedule-form').reset(); $('form-error').hidden = true; $('test-result').hidden = true;
  $('editor-title').textContent = s ? 'Редактировать расписание' : 'Новое расписание';
  document.querySelector(`input[name="recipient-kind"][value="${s?.recipient.kind || 'personal'}"]`).checked = true;
  $('recipient-search').value = ''; renderRecipients(s?.recipient.jid || ''); $('message').value = s?.text || '';
  $('schedule-kind').value = s?.kind || 'once';
  const d = new Date(Date.now()+3600000), pad = n => String(n).padStart(2,'0');
  const once = s?.once || `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  [$('once-date').value,$('once-time').value] = once.split('T');
  $('from').value = s?.from || '08:00'; $('to').value = s?.to || '08:00'; $('interval').value = s?.interval || '00:30';
  for (const input of $('weekdays').querySelectorAll('input')) input.checked = s?.days?.includes(Number(input.value)) || false;
  showKind(); $('editor').showModal();
}
function payload() {
  return { id:editing, recipient:state.recipients.find(r => r.jid === $('recipient').value), text:$('message').value,kind:$('schedule-kind').value,once:`${$('once-date').value}T${$('once-time').value}`,days:[...$('weekdays').querySelectorAll('input:checked')].map(i => Number(i.value)),from:$('from').value,to:$('to').value,interval:$('interval').value };
}
for (const day of [1,2,3,4,5,6,0]) { const label = element('label'), input = element('input'); input.type='checkbox'; input.value=String(day); label.append(input,dayNames[day]); $('weekdays').append(label); }
for (const tab of document.querySelectorAll('.tab')) tab.addEventListener('click',()=> { for(const t of document.querySelectorAll('.tab')) { t.classList.toggle('selected',t === tab); $(`${t.dataset.tab}-panel`).hidden = t !== tab; } });
$('new').addEventListener('click',()=>openEditor());
$('schedule-kind').addEventListener('change',showKind);
$('recipient-search').addEventListener('input',()=>renderRecipients());
for(const input of document.querySelectorAll('input[name="recipient-kind"]')) input.addEventListener('change',()=> { $('recipient-search').value='';renderRecipients(''); });
for(const id of ['close-editor','cancel']) $(id).addEventListener('click',()=> { if(!formBusy) $('editor').close(); });
$('editor').addEventListener('cancel',event=> { if(formBusy) event.preventDefault(); });
$('refresh').addEventListener('click',()=>action(async()=>{ $('refresh').disabled=true; try { await call('refresh'); notice('Списки обновлены.'); } finally { $('refresh').disabled=state.connection !== 'WhatsApp подключён'; } }));
$('save-settings').addEventListener('click',()=>action(async()=>{ await call('settings',{grace:Number($('grace').value),autostart:$('autostart').checked,paused:$('global-paused').checked});notice('Настройки сохранены.'); }));
async function formAction(fn) {
  if(formBusy) return;
  formBusy=true; $('save').disabled=true; $('test').disabled=true; $('form-error').hidden=true; $('test-result').hidden=true;
  try { await fn(); } catch(e) { $('form-error').textContent=e.message; $('form-error').hidden=false; }
  finally { formBusy=false; $('save').disabled=false; $('test').disabled=false; }
}
$('test').addEventListener('click',()=>formAction(async()=> { const p=payload(); await call('test',{recipient:p.recipient,text:p.text}); $('test-result').textContent='Тестовое сообщение отправлено.'; $('test-result').className='success'; $('test-result').hidden=false; }));
$('schedule-form').addEventListener('submit',event=> {event.preventDefault();void formAction(async()=> { await call('save',payload());$('editor').close();notice('Расписание сохранено.'); });});
window.waScheduler.subscribe(render);
void action(()=>call('state'));
