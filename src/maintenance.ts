import type {Queue} from 'bullmq';
import type {Redis} from 'ioredis';
import type {Config} from './config.js';
import {keyOf} from './scope.js';
export async function maintain(c:Config,r:Redis,queues:Queue[],now=Date.now()) {
 for(const q of queues){await q.clean(7*86400000,1000,'completed');await q.clean(30*86400000,1000,'failed');}
 const key=keyOf(c,'maintenance:last'),last=Number(await r.get(key));
 if(now-last>=86400000){
  // Explicit compaction is independent of new job completions/traffic.
  await r.bgrewriteaof();await r.bgsave('SCHEDULE');await r.set(key,String(now));
 }
}
