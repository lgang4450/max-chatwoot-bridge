import { Redis } from 'ioredis';
import { Queue,Worker } from 'bullmq';
import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { Bridge } from './bridge.js';
import { report } from './security.js';
async function main() {
  const cfg=loadConfig();
  const redis=new Redis(cfg.redisUrl,{maxRetriesPerRequest:1,connectTimeout:3000});redis.on('error',()=>report('redis_unavailable'));
  await redis.ping();
  const workers:Worker[]=[];const queues:Queue[]=[];
  if(cfg.enabled) {
    const bridge=new Bridge(cfg,redis);await bridge.validate();
    for(const direction of ['in','out'] as const) {
      const queue=new Queue('max-bridge-'+direction,{connection:{url:cfg.redisUrl,maxRetriesPerRequest:1},defaultJobOptions:{attempts:6,backoff:{type:'exponential',delay:3000},removeOnComplete:{age:7*86400,count:1000},removeOnFail:{age:30*86400,count:1000}}});
      queues.push(queue);
      const worker=new Worker(queue.name,async job=>direction==='in'?bridge.incoming(job.data):bridge.outgoing(job.data),{connection:{url:cfg.redisUrl},concurrency:1,limiter:{max:5,duration:1000}});
      worker.on('error',()=>report('worker_unavailable'));
      worker.on('failed',async(job)=>{
        report('job_failed');
        if(direction==='out' && job && (await job.getState())==='failed') {
          try {await bridge.cw.note(job.data.conversation.id,'Ответ в MAX не подтверждён. Требуется проверка доставки; автоматическая повторная отправка остановлена.');}catch {report('operator_notice_failed');}
        }
      });
      workers.push(worker);
    }
  }
  const app=createApp(cfg,async(direction,id,payload)=>{
    const queue=queues[direction==='in'?0:1];
    if(await queue.getWaitingCount()+await queue.getDelayedCount()>=cfg.maxQueue) throw new Error('Queue capacity');
    await queue.add('message',payload,{jobId:direction+'-'+id});
  },async()=>{await redis.ping();return Promise.all(queues.map(q=>q.getJobCounts('waiting','active','delayed','failed')));});
  const server=app.listen(cfg.port,'0.0.0.0',()=>report(cfg.enabled?'bridge_active':'bridge_prepared'));
  server.requestTimeout=10000;server.headersTimeout=10000;
  let stopping=false;
  const shutdown=async()=>{if(stopping)return;stopping=true;server.close();await Promise.all(workers.map(w=>w.close()));await Promise.all(queues.map(q=>q.close()));await redis.quit();};
  process.on('SIGTERM',()=>void shutdown());process.on('SIGINT',()=>void shutdown());
}
main().catch(()=>{report('startup_failed');process.exit(1);});
