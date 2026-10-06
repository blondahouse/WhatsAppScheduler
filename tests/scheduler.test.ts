import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { executions, Scheduler, latestDue, consumed } from '../src/scheduler.ts';
import { validate, parseLocal, type Schedule, type Recipient } from '../src/model.ts';
import { Store } from '../src/store.ts';
const monday = new Date(2026, 9, 12);
const at = (h: number, m = 0) => new Date(2026, 9, 12, h, m).getTime();
const personal: Recipient = { jid: '380501234567@s.whatsapp.net', name: 'Marina', kind: 'personal' };
const group: Recipient = { jid: '1203630123456789@g.us', name: '3 рота', kind: 'group' };
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
