import test from 'node:test';
import assert from 'node:assert/strict';
import {Queue,Worker} from 'bullmq';
const url=process.env.REDIS_TEST_URL;
test('real Redis queue keeps retries and suppresses repeated webhook job IDs across reconnect',{skip:!url},async()=>{
 const name='max-test-'+process.pid+'-'+Date.now(),connection={url};let queue=new Queue(name,{connection});let worker;
 try {
  await queue.add('message',{fixture:true},{jobId:'stable',attempts:2,backoff:{type:'fixed',delay:100}});
  await queue.close();queue=new Queue(name,{connection});await queue.add('message',{fixture:true},{jobId:'stable'});
  assert.equal(await queue.getWaitingCount(),1);
  let calls=0;worker=new Worker(name,async()=>{if(++calls===1)throw Error('fixture failure');return 'ok'},{connection});worker.on('error',()=>{});
  for(let i=0;i<100;i++){const job=await queue.getJob('stable');if(await job.getState()==='completed')break;await new Promise(r=>setTimeout(r,100));}
  assert.equal(await (await queue.getJob('stable')).getState(),'completed');assert.equal(calls,2);
 } finally {await worker?.close();await queue.obliterate({force:true});await queue.close();}
});
test('atomic durable admission enforces sender/global quotas and survives admission-to-job crash',{skip:!url},async()=>{
 const {Redis}=await import('ioredis');const {Admission}=await import('../dist/admission.js');const {loadConfig}=await import('../dist/config.js');const {queueName,keyOf}=await import('../dist/scope.js');
 const c=loadConfig({MAX_BOT_ID:String(Date.now()),MAX_QUEUE_DEPTH:'5'}),r=new Redis(url),q=new Queue(queueName(c,'in'),{connection:{url}}),a=new Admission(c,r,q,'in');
 try{
  const attempts=await Promise.allSettled(Array.from({length:30},(_,i)=>a.accept('in-'+i,'user-a',{fixture:i})));
  assert.equal(attempts.filter(x=>x.status==='fulfilled').length,2);
  for(let i=0;i<3;i++)await a.accept('other-'+i,'user-'+i,{fixture:i});await assert.rejects(()=>a.accept('overflow','new-user',{}));
  // Admission payload is durable even when queue.add was never reached.
  const restored=new Admission(c,r,q,'in');await restored.pump();assert.equal(await q.getWaitingCount(),5);
  await a.accept('in-0','user-a',{mutated:true});assert.equal((await q.getJob('in-0')).data.fixture,0);
 }finally{await q.obliterate({force:true});await q.close();const keys=await r.keys(keyOf(c,'*'));if(keys.length)await r.del(...keys);await r.quit();}
});
test('persistent Redis fingerprint fails closed across configurations',{skip:!url},async()=>{
 const {Redis}=await import('ioredis');const {loadConfig}=await import('../dist/config.js');const {assertScope}=await import('../dist/scope.js');
 const u=new URL(url);u.pathname='/2';const r=new Redis(u.href),c=loadConfig({MAX_BOT_ID:'99123'});
 try{await assertScope(c,r);await assert.rejects(()=>assertScope({...c,inbox:99},r));}finally{await r.del('max-bridge:config');await r.quit();}
});
test('periodic cleanup removes old completed payload without another completion',{skip:!url},async()=>{
 const {Redis}=await import('ioredis');const {maintain}=await import('../dist/maintenance.js');const {loadConfig}=await import('../dist/config.js');const {queueName,keyOf}=await import('../dist/scope.js');
 const c=loadConfig({MAX_BOT_ID:String(Date.now()+991)}),r=new Redis(url),q=new Queue(queueName(c,'in'),{connection:{url}});let w;
 try{await q.add('fixture',{privateText:'RETENTION_FIXTURE'},{jobId:'old'});w=new Worker(q.name,async()=>1,{connection:{url}});
  for(let i=0;i<100;i++){if(await (await q.getJob('old')).getState()==='completed')break;await new Promise(r=>setTimeout(r,10));}await w.close();w=null;
  const old=Date.now()-8*86400000;await r.hset(q.toKey('old'),'finishedOn',String(old));await r.zadd(q.toKey('completed'),old,'old');
  await r.set(keyOf(c,'maintenance:last'),String(Date.now()));await maintain(c,r,[q]);assert.equal(await q.getJob('old'),undefined);
 }finally{await w?.close();await q.obliterate({force:true});await q.close();const keys=await r.keys(keyOf(c,'*'));if(keys.length)await r.del(...keys);await r.quit();}
});
test('expired unprocessed admission is removed without new incoming traffic',{skip:!url},async()=>{
 const {Redis}=await import('ioredis');const {Admission}=await import('../dist/admission.js');const {loadConfig}=await import('../dist/config.js');const {queueName,keyOf}=await import('../dist/scope.js');
 const c=loadConfig({MAX_BOT_ID:String(Date.now()+1234)}),r=new Redis(url),q=new Queue(queueName(c,'in'),{connection:{url}}),a=new Admission(c,r,q,'in');
 try{await a.accept('expired','fixture-user',{privateText:'EXPIRED_FIXTURE'});await a.pump();await a.expireOld(Date.now()+31*86400000);assert.equal(await q.getJob('expired'),undefined);assert.equal(await r.hget(keyOf(c,'admit-in')+':payload','expired'),null);}
 finally{await q.obliterate({force:true});await q.close();const keys=await r.keys(keyOf(c,'*'));if(keys.length)await r.del(...keys);await r.quit();}
});
