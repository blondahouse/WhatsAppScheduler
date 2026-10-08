import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { executions, Scheduler, latestDue, consumed } from '../src/scheduler.ts';
import { validate, parseLocal, type Schedule, type Recipient } from '../src/model.ts';
import { Store } from '../src/store.ts';
import { PersistenceError } from '../src/connection-policy.ts';
const monday = new Date(2026, 9, 12);
const at = (h: number, m = 0) => new Date(2026, 9, 12, h, m).getTime();
const personal: Recipient = { jid: '380501234567@s.whatsapp.net', name: 'Marina', kind: 'personal' };
const group: Recipient = { jid: '1203630123456789@g.us', name: '3 рота', kind: 'group' };
test('a persistence failure after sending is propagated and keeps the durable sending claim', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'wa-persistence-'));
  try {
    const store = new Store(join(directory, 'state.json'));
    const engine = new Scheduler(store, async () => {
      store.change = () => { throw new PersistenceError('local data', new Error('disk failure')); };
    }, () => true);
    await assert.rejects(engine.test(personal, 'test'), PersistenceError);
    assert.equal(store.data.history[0].result, 'sending');
    assert.equal(JSON.parse(readFileSync(store.path, 'utf8')).history[0].result, 'sending');
    assert.equal(engine.inFlight.size, 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
function schedule(overrides: Partial<Schedule> = {}): Schedule {
  return { id:'schedule-1',recipient:personal,text:'Доброе утро\n🙂',enabled:true,kind:'weekly',days:[1],from:'08:00',to:'12:00',interval:'00:30',createdAt:at(0),updatedAt:at(0),notBefore:at(0),status:'active',consumed:{},floorDate:'',...overrides };
}
function fixture(s = schedule()) {
  const directory=mkdtempSync(join(tmpdir(),'wa-scheduler-test-'));
  const path=join(directory,'state.json'),store=new Store(path);
  store.change(d=>{ d.schedules.push(s); });
  let sent=0, online=true;
  const engine=new Scheduler(store,async()=>{ sent++; },()=>online);
  return { store,path,engine,count:()=>sent,offline:()=>{online=false;},online:()=>{online=true;},dispose:()=>rmSync(directory,{recursive:true,force:true}) };
}
test('normal weekly 08:00–12:00 every 30 minutes, Monday only',()=> {
  const slots=executions(schedule(),monday);
  assert.deepEqual(slots.map(x=>x.minute),[480,510,540,570,600,630,660,690,720]);
  assert.equal(executions(schedule(),new Date(2026,9,13)).length,0);
});
test('equal start/end has exactly one execution regardless of interval',()=> {
  assert.deepEqual(executions(schedule({to:'08:00',interval:'04:00'}),monday).map(x=>x.minute),[480]);
});
test('inclusive end boundary',()=>assert.deepEqual(executions(schedule({to:'09:00'}),monday).map(x=>x.minute),[480,510,540]));
test('non-divisible interval does not exceed end',()=>assert.deepEqual(executions(schedule({to:'09:00',interval:'00:40'}),monday).map(x=>x.minute),[480,520]));
test('validation rejects midnight crossing, zero interval, no days, malformed time',()=> {
  for(const s of [schedule({from:'22:00',to:'02:00'}),schedule({interval:'00:00'}),schedule({days:[]}),schedule({interval:'24:00'}),schedule({from:'8:00'}),schedule({to:'08:99'})])assert.throws(()=>validate(s,at(0)));
  validate(schedule({from:'08:00',to:'08:00'}),at(0));
});
test('one-time future validation and exactly once across restart',async()=> {
  const s=schedule({kind:'once',once:'2026-10-12T08:00'});
  validate(s,at(7)); assert.throws(()=>validate(s,at(9)));
  const f=fixture(s);
  try {
    await f.engine.tick(at(8)); await f.engine.tick(at(8,1));
    assert.equal(f.count(),1); assert.equal(f.store.data.schedules[0].status,'completed');
    const reopened=new Store(f.path);let sends=0;
    await new Scheduler(reopened,async()=>{sends++;},()=>true).tick(at(8,2));
    assert.equal(sends,0);
  }finally{f.dispose();}
});
test('weekly successful execution never duplicates on restart',async()=> {
  const f=fixture();try {
    await f.engine.tick(at(8));const reopened=new Store(f.path);let sends=0;
    await new Scheduler(reopened,async()=>{sends++;},()=>true).tick(at(8,1));
    assert.equal(f.count(),1);assert.equal(sends,0);
  }finally{f.dispose();}
});
test('missed recurring coalesces into latest execution, then continues normally',async()=> {
  const f=fixture(schedule({interval:'00:10'}));try {
    await f.engine.tick(at(8,28));assert.equal(f.count(),1);
    assert.equal(f.store.data.history[0].slot,'2026-10-12T08:20');
    await f.engine.tick(at(8,29));assert.equal(f.count(),1);
    await f.engine.tick(at(8,30));assert.equal(f.count(),2);
    assert.ok(consumed(f.store.data.schedules[0],executions(schedule({interval:'00:10'}),monday)[0]));
  }finally{f.dispose();}
});
test('30-minute grace catches 08:00 at 08:13 but expires at 09:00',async()=> {
  for(const [h,m,count] of [[8,13,1],[9,0,0]]) {
    const f=fixture(schedule({to:'08:00'}));try {await f.engine.tick(at(h,m));assert.equal(f.count(),count);assert.equal(f.store.data.history[0].result,count?'sent':'skipped');}finally{f.dispose();}
  }
});
test('exact grace boundary is accepted',async()=> {const f=fixture(schedule({to:'08:00'}));try{await f.engine.tick(at(8,30));assert.equal(f.count(),1);}finally{f.dispose();}});
test('no missed allows current minute but not a later minute',async()=> {
  for(const delta of [29000,60000]){const f=fixture(schedule({to:'08:00'}));try {f.store.change(d=>{d.settings.grace=0;});await f.engine.tick(at(8)+delta);assert.equal(f.count(),delta<60000?1:0);}finally{f.dispose();}}
});
test('offline attempts wait for reconnect inside grace',async()=> {
  const f=fixture(schedule({to:'08:00'}));try {f.offline();await f.engine.tick(at(8));assert.equal(f.store.data.history.length,0);f.online();await f.engine.tick(at(8,13));assert.equal(f.count(),1);}finally{f.dispose();}
});
test('offline execution expires and is not sent on later reconnect',async()=> {
  const f=fixture(schedule({to:'08:00'}));try {f.offline();await f.engine.tick(at(9));f.online();await f.engine.tick(at(9,1));assert.equal(f.count(),0);assert.equal(f.store.data.history.length,1);}finally{f.dispose();}
});
test('overlapping ticks are serialized',async()=> {
  const f=fixture();try {await Promise.all([f.engine.tick(at(8)),f.engine.tick(at(8)),f.engine.tick(at(8))]);assert.equal(f.count(),1);}finally{f.dispose();}
});
test('claim is on disk before network send; ambiguous failure is never retried',async()=> {
  const f=fixture();let count=0;try {
    const engine=new Scheduler(f.store,async()=>{count++;const disk=JSON.parse(readFileSync(f.path,'utf8'));assert.equal(disk.history[0].result,'sending');throw new Error('Disconnected after server accepted');},()=>true);
    await engine.tick(at(8)); await engine.tick(at(8,1));
    const reopened=new Store(f.path);await new Scheduler(reopened,async()=>{count++;},()=>true).tick(at(8,2));
    assert.equal(count,1);assert.equal(reopened.data.history[0].result,'uncertain');
  }finally{f.dispose();}
});
test('real process death after send leaves durable claim, restart does not send again',async()=> {
  const f=fixture();try {
    const code=`import {Store} from ${JSON.stringify(new URL('../src/store.ts',import.meta.url).href)};import {Scheduler} from ${JSON.stringify(new URL('../src/scheduler.ts',import.meta.url).href)};const s=new Store(process.argv[1]);await new Scheduler(s,async()=>{process.exit(91)},()=>true).tick(Number(process.argv[2]));`;
    assert.throws(()=>execFileSync(process.execPath,['--input-type=module','-e',code,f.path,String(at(8))]),(e:any)=>e.status===91);
    const reopened=new Store(f.path);let sends=0;await new Scheduler(reopened,async()=>{sends++;},()=>true).tick(at(8,1));
    assert.equal(sends,0);assert.equal(reopened.data.history[0].result,'uncertain');assert.equal(reopened.data.schedules[0].status,'error');
  }finally{f.dispose();}
});
test('personal and group JIDs persist without mixing types',()=> {
  const f=fixture();try {f.store.change(d=>{d.recipients=[personal,group];d.schedules.push(schedule({id:'group',recipient:group}));});const r=new Store(f.path);assert.deepEqual(r.data.recipients,[personal,group]);assert.equal(r.data.schedules[1].recipient.jid,group.jid);assert.throws(()=>validate(schedule({recipient:{...personal,kind:'group'}}),at(0)));}finally{f.dispose();}
});
test('restart retains auth-independent settings and Unicode multiline text',()=> {
  const f=fixture();try {f.store.change(d=>{d.settings.grace=15;d.settings.autostart=false;});const r=new Store(f.path);assert.equal(r.data.settings.grace,15);assert.equal(r.data.settings.autostart,false);assert.equal(r.data.schedules[0].text,'Доброе утро\n🙂');}finally{f.dispose();}
});
test('corrupt store is rejected instead of silently resetting',()=> {
  const f=fixture();try {writeFileSync(f.path,'broken');assert.throws(()=>new Store(f.path));}finally{f.dispose();}
});
test('test sends are logged and do not change schedules',async()=> {
  const f=fixture();try {await f.engine.test(group,'Тест 🙂');assert.equal(f.count(),1);assert.equal(f.store.data.history[0].result,'sent');assert.equal(f.store.data.schedules[0].status,'active');}finally{f.dispose();}
});
test('global and individual pause stop execution',async()=> {
  const f=fixture();try {f.store.change(d=>{d.settings.paused=true;});await f.engine.tick(at(8));assert.equal(f.count(),0);f.store.change(d=>{d.settings.paused=false;d.schedules[0].enabled=false;});await f.engine.tick(at(8));assert.equal(f.count(),0);}finally{f.dispose();}
});
test('DST nonexistent wall time is rejected; repeated minute creates one slot',()=> {
  const code=`import {parseLocal} from ${JSON.stringify(new URL('../src/model.ts',import.meta.url).href)};import {executions} from ${JSON.stringify(new URL('../src/scheduler.ts',import.meta.url).href)};let rejected=false;try{parseLocal('2026-03-08T02:30')}catch{rejected=true}if(!rejected)process.exit(1);const s={kind:'weekly',days:[0],from:'01:30',to:'01:30',interval:'00:01'};if(executions(s,new Date(2026,10,1)).length!==1)process.exit(2);`;
  execFileSync(process.execPath,['--input-type=module','-e',code],{env:{...process.env,TZ:'America/New_York'}});
});
test('latest due respects creation and edit time',()=>assert.equal(latestDue(schedule({notBefore:at(8,29)}),at(8,29)),undefined));
test('timezone change making one-time wall time nonexistent disables only that schedule',async()=> {
  const code=`import {Store} from ${JSON.stringify(new URL('../src/store.ts',import.meta.url).href)};import {Scheduler} from ${JSON.stringify(new URL('../src/scheduler.ts',import.meta.url).href)};const store=new Store(process.argv[1]);store.change(d=>{d.schedules[0].kind='once';d.schedules[0].once='2026-03-08T02:30'});await new Scheduler(store,async()=>{throw new Error('must not send')},()=>true).tick(Date.now());if(store.data.schedules[0].enabled||store.data.schedules[0].status!=='error')process.exit(1);`;
  const f=fixture();try{execFileSync(process.execPath,['--input-type=module','-e',code,f.path],{env:{...process.env,TZ:'America/New_York'}});}finally{f.dispose();}
});

test('jitter has nonzero integer offsets within bounds, both signs, and a stable per-slot draw', () => {
  const s = schedule({ jitterMinutes: 5, jitterSeed: 'persistent-random-seed', interval: '00:01' });
  const slots = executions(s, monday);
  assert.ok(slots.every(x => Number.isInteger(x.jitterOffset) && x.jitterOffset !== 0 && Math.abs(x.jitterOffset!) <= 5));
  assert.ok(slots.some(x => x.jitterOffset! < 0));
  assert.ok(slots.some(x => x.jitterOffset! > 0));
  assert.deepEqual(executions(s, monday), slots);
  assert.ok(slots.every(x => x.at === x.nominalAt! + x.jitterOffset! * 60000));
});
function jitterSchedule(sign: number, overrides: Partial<Schedule> = {}): Schedule {
  for (let n = 0; n < 100; n++) {
    const s = schedule({ to: '08:00', jitterMinutes: 1, jitterSeed: `seed-${n}`, ...overrides });
    if (executions(s, monday)[0].jitterOffset === sign) return s;
  }
  throw new Error('Test seed not found');
}
test('jitter validation rejects fractions, negative values, excessive minutes and past early window', () => {
  for (const jitterMinutes of [-1, 0.5, 1441, NaN, Infinity]) assert.throws(() => validate(schedule({ jitterMinutes }), at(0)));
  validate(schedule({ jitterMinutes: 0 }), at(0));
  validate(schedule({ jitterMinutes: 1440 }), at(0));
  assert.throws(() => validate(schedule({ kind: 'once', once: '2026-10-12T08:00', jitterMinutes: 5 }), at(7,56)), /entire jitter window/);
  validate(schedule({ kind: 'once', once: '2026-10-12T08:00', jitterMinutes: 5 }), at(7,54));
});
test('early jitter is sent before nominal time and never duplicated after restart', async () => {
  const s = jitterSchedule(-1), f = fixture(s);
  try {
    await f.engine.tick(at(7,58)); assert.equal(f.count(), 0);
    await f.engine.tick(at(7,59)); assert.equal(f.count(), 1);
    assert.equal(f.store.data.history[0].plannedAt, at(7,59));
    assert.equal(f.store.data.history[0].jitterOffset, -1);
    const restored = new Store(f.path); let sends = 0;
    assert.equal(executions(restored.data.schedules[0], monday)[0].at, at(7,59));
    await new Scheduler(restored, async () => { sends++; }, () => true).tick(at(8,1));
    assert.equal(sends, 0);
  } finally { f.dispose(); }
});
test('late jitter waits past nominal time, then sends within the allowed minute', async () => {
  const f = fixture(jitterSchedule(1));
  try {
    await f.engine.tick(at(8)); assert.equal(f.count(), 0);
    await f.engine.tick(at(8,1) + 29000); assert.equal(f.count(), 1);
  } finally { f.dispose(); }
});
test('jitter catch-up never sends in nominal minute and skips outside the jitter window', async () => {
  const f = fixture(jitterSchedule(-1));
  try {
    await f.engine.tick(at(8)); assert.equal(f.count(), 0);
    await f.engine.tick(at(8,1)); assert.equal(f.count(), 1);
  } finally { f.dispose(); }
  const late = fixture(jitterSchedule(1));
  try {
    await late.engine.tick(at(8,2)); assert.equal(late.count(), 0);
    assert.equal(late.store.data.history[0].result, 'skipped');
    assert.match(late.store.data.history[0].error!, /jitter window/);
  } finally { late.dispose(); }
});
test('jitter crosses midnight using the nominal day, including early executions from tomorrow', async () => {
  const s = jitterSchedule(-1, { from: '00:00', to: '00:00', notBefore: new Date(2026,9,11,20).getTime() });
  const f = fixture(s);
  try {
    const sunday = new Date(2026,9,11,23,59).getTime();
    await f.engine.tick(sunday); assert.equal(f.count(),1);
    assert.equal(f.store.data.history[0].slot, '2026-10-12T00:00');
    await f.engine.tick(at(0)); assert.equal(f.count(),1);
  } finally { f.dispose(); }
});
test('normal jitter collisions preserve distinct executions; missed jitter coalesces after sleep', async () => {
  let s: Schedule | undefined;
  for (let n = 0; n < 200; n++) {
    const candidate = schedule({ jitterMinutes: 1, jitterSeed: `collision-${n}`, to: '08:02', interval: '00:01' });
    const slots = executions(candidate,monday);
    if (slots[0].at === at(8,1) && slots[2].at === at(8,1)) { s=candidate; break; }
  }
  assert.ok(s);
  const f=fixture(s);
  try {
    await f.engine.tick(at(8,1));
    const sent = f.store.data.history.filter(h => h.result === 'sent');
    assert.equal(sent.length,2);
    assert.deepEqual(sent.map(h => h.slot).sort(),['2026-10-12T08:00','2026-10-12T08:02']);
  } finally { f.dispose(); }
  const missed = fixture(schedule({ jitterMinutes: 5, jitterSeed: 'sleep', interval:'00:01' }));
  try { await missed.engine.tick(at(8,28)); assert.equal(missed.count(),1); }
  finally { missed.dispose(); }
});
test('jitter one-time completion and immediate test-send do not share the scheduled random execution', async () => {
  const s = jitterSchedule(1,{kind:'once',once:'2026-10-12T08:00'}),f=fixture(s);
  try {
    await f.engine.test(personal,'Immediate'); assert.equal(f.count(),1);
    await f.engine.tick(at(8)); assert.equal(f.count(),1);
    await f.engine.tick(at(8,1)); assert.equal(f.count(),2);
    assert.equal(f.store.data.schedules[0].status,'completed');
  } finally { f.dispose(); }
});

test('out-of-order jitter never consumes an earlier nominal slot that is still scheduled in the future', async () => {
  let s: Schedule | undefined;
  for (let n=0;n<200;n++) {
    const candidate=schedule({jitterMinutes:5,jitterSeed:`order-${n}`,to:'08:02',interval:'00:02'});
    const [first,second]=executions(candidate,monday);
    if(second.at<first.at && second.at!==at(8) && first.at!==at(8,2)) {s=candidate;break;}
  }
  assert.ok(s);
  const [first,second]=executions(s,monday),f=fixture(s);
  try {
    await f.engine.tick(second.at);assert.equal(f.count(),1);
    assert.equal(f.store.data.history[0].slot,second.key);
    assert.equal(consumed(f.store.data.schedules[0],first),false);
    await f.engine.tick(first.at);assert.equal(f.count(),2);
    assert.equal(f.store.data.history[1].slot,first.key);
  } finally {f.dispose();}
});
test('DST fall-back jitter cannot reproduce the same nominal local wall minute',()=> {
  const code=`import {executions} from ${JSON.stringify(new URL('../src/scheduler.ts',import.meta.url).href)};for(let n=0;n<300;n++){const s={kind:'weekly',days:[0],from:'01:30',to:'01:30',interval:'00:01',jitterMinutes:120,jitterSeed:'dst-'+n};const [slot]=executions(s,new Date(2026,10,1));const d=new Date(slot.at);if(d.getDate()===1&&d.getHours()===1&&d.getMinutes()===30)process.exit(1);}`;
  execFileSync(process.execPath,['--input-type=module','-e',code],{env:{...process.env,TZ:'America/New_York'}});
});
