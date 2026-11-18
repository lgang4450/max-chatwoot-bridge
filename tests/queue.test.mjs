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
