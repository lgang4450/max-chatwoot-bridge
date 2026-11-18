import { Redis } from 'ioredis';
import {randomUUID} from 'node:crypto';
import {maintain} from './maintenance.js';
import {Admission} from './admission.js';
import {assertScope,keyOf,queueName} from './scope.js';
import { Queue,Worker,DelayedError } from 'bullmq';
import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { Bridge } from './bridge.js';
import { report } from './security.js';
async function main() {
  const cfg=loadConfig();
  const redis=new Redis(cfg.redisUrl,{maxRetriesPerRequest:1,connectTimeout:3000});redis.on('error',()=>report('redis_unavailable'));
  await redis.ping();await assertScope(cfg,redis);
  const workers:Worker[]=[];const queues:Queue[]=[];const admissions:Admission[]=[];const timers:NodeJS.Timeout[]=[];
  const bridge=cfg.enabled?new Bridge(cfg,redis):null;if(bridge)await bridge.validate();
    for(const direction of ['in','out'] as const) {
      const queue=new Queue(queueName(cfg,direction),{connection:{url:cfg.redisUrl,maxRetriesPerRequest:1},defaultJobOptions:{attempts:6,backoff:{type:'exponential',delay:3000},removeOnComplete:{age:7*86400,count:1000},removeOnFail:{age:30*86400,count:1000}}});
      queue.on('error',()=>report('queue_unavailable'));
      queues.push(queue);const admission=new Admission(cfg,redis,queue,direction);admissions.push(admission);
      if(cfg.enabled)timers.push(setInterval(()=>void admission.pump().catch(()=>report('pump_failed')),1000));
      if(!bridge)continue;
      const worker=new Worker(queue.name,async(job,token)=>{
        if(direction==='out')return bridge.outgoing(job.data);
        const user=String(job.data.message.sender.user_id),lock=keyOf(cfg,'processing-'+user),owner=randomUUID();
        if(!await redis.set(lock,owner,'PX',30000,'NX')){await job.moveToDelayed(Date.now()+200,token);throw new DelayedError();}
        const renew=setInterval(()=>void redis.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('PEXPIRE',KEYS[1],30000) end",1,lock,owner).catch(()=>report('lease_failed')),10000);
        try{return await bridge.incoming(job.data);}finally{clearInterval(renew);await redis.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end",1,lock,owner);}
      },{connection:{url:cfg.redisUrl},concurrency:direction==='in'?4:1,limiter:{max:10,duration:1000}});
      worker.on('completed',job=>void admission.release(job.id!).catch(()=>report('admission_release_failed')));
      worker.on('error',()=>report('worker_unavailable'));
      worker.on('failed',async(job)=>{
        report('job_failed');
        try {
        if(job && (await job.getState())==='failed') {
          await admission.release(job.id!);
        if(direction==='out') {
          try {await bridge.cw.note(job.data.conversation.id,'Ответ в MAX не подтверждён. Требуется проверка доставки; автоматическая повторная отправка остановлена.',(await redis.get(keyOf(cfg,'recipient-'+job.data.conversation.id)))||'');}catch {report('operator_notice_failed');}
        }}
        } catch {report('failure_notice_failed');}
      });
      workers.push(worker);
    }
  timers.push(setInterval(()=>void (async()=>{for(const a of admissions)await a.expireOld();await maintain(cfg,redis,queues);})().catch(()=>report('retention_failed')),3600000));
  void maintain(cfg,redis,queues).catch(()=>report('retention_failed'));
  const app=createApp(cfg,async(direction,id,payload)=>{
    const owner=direction==='in'?String(payload.message.sender.user_id):String(payload.conversation.id);
    await admissions[direction==='in'?0:1].accept(direction+'-'+id,owner,payload);
  },async()=>{await redis.ping();return Promise.all(queues.map(q=>q.getJobCounts('waiting','active','delayed','failed')));});
  const server=app.listen(cfg.port,'0.0.0.0',()=>report(cfg.enabled?'bridge_active':'bridge_prepared'));
  server.maxConnections=32;server.maxRequestsPerSocket=100;server.requestTimeout=10000;server.headersTimeout=10000;
  let stopping=false;
  const shutdown=async()=>{if(stopping)return;stopping=true;server.close();timers.forEach(clearInterval);await Promise.all(workers.map(w=>w.close()));await Promise.all(queues.map(q=>q.close()));await redis.quit();};
  process.on('SIGTERM',()=>void shutdown());process.on('SIGINT',()=>void shutdown());
}
main().catch(()=>{report('startup_failed');process.exit(1);});
