import {Redis} from 'ioredis';
import {Queue} from 'bullmq';
import {queueName,assertScope} from './scope.js';
import {loadConfig} from './config.js';
import {Bridge} from './bridge.js';
async function main() {
 const cfg=loadConfig(),op=process.argv[2];
 const redis=new Redis(cfg.redisUrl,{maxRetriesPerRequest:1});redis.on('error',()=>{});
 try {
  if(op==='rebind-empty'){const old=await redis.get('max-bridge:config');const keys=await redis.keys('*');if(keys.some(k=>k!=='max-bridge:config' && !k.startsWith('bull:max-bridge-'+old+'-') && k!=='mb:'+old+':maintenance:last'))throw Error();for(const d of ['in','out']){const q=new Queue('max-bridge-'+old+'-'+d,{connection:{url:cfg.redisUrl}});const counts=await q.getJobCounts();if(Object.values(counts).some(n=>n>0))throw Error();await q.obliterate({force:true});await q.close();}if(old)await redis.del('mb:'+old+':maintenance:last');await redis.del('max-bridge:config');await assertScope(cfg,redis);return;}
  await assertScope(cfg,redis);
  if(op==='status') {
   const counts=[];for(const d of ['in','out']){const q=new Queue(queueName(cfg,d),{connection:{url:cfg.redisUrl}});counts.push({direction:d,counts:await q.getJobCounts('waiting','active','delayed','failed','completed')});await q.close();}
   console.log(JSON.stringify({enabled:cfg.enabled,queues:counts}));return;
  }
  if(op==='subscribe') {
   if(!cfg.enabled) throw Error();const bridge=new Bridge(cfg,redis);await bridge.validate();
   const url=new URL(process.env.MAX_PUBLIC_WEBHOOK_URL||'');if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash) throw Error();
   const current=await bridge.bot.api.getSubscriptions();if(current.some(s=>s.url!==url.href)) throw Error();
   await bridge.bot.api.subscribe(url.href,cfg.maxSecret,['message_created']);console.log(JSON.stringify({subscribed:true}));return;
  }
  if(op==='retry-in') {
   const id=process.argv[3];if(!/^in-[0-9a-f]{64}$/.test(id||''))throw Error();
   const queue=new Queue(queueName(cfg,'in'),{connection:{url:cfg.redisUrl}});
   try {const job=await queue.getJob(id);if(!job||await job.getState()!=='failed')throw Error();await job.retry();console.log(JSON.stringify({retried:true}));}finally{await queue.close();}return;
  }
  throw Error();
 } finally {await redis.quit();}
}
main().catch(()=>{console.error('Operation failed; inspect configuration/queue without printing credentials');process.exitCode=1;});
