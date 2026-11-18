import type {Redis} from 'ioredis';
import type {Queue} from 'bullmq';
import type {Config} from './config.js';
import {keyOf} from './scope.js';
import {digest} from './security.js';
const ADMIT=`
 if redis.call('EXISTS',KEYS[5])==1 or redis.call('HEXISTS',KEYS[2],ARGV[1])==1 then return 0 end
 if redis.call('ZCARD',KEYS[1])>=tonumber(ARGV[4]) or tonumber(redis.call('HGET',KEYS[3],ARGV[2]) or '0')>=tonumber(ARGV[5]) or tonumber(redis.call('GET',KEYS[4]) or '0')>=tonumber(ARGV[6]) then return -1 end
 redis.call('ZADD',KEYS[1],ARGV[3],ARGV[1]);redis.call('HSET',KEYS[2],ARGV[1],ARGV[7]);redis.call('HINCRBY',KEYS[3],ARGV[2],1)
 redis.call('HSET',KEYS[6],ARGV[1],ARGV[2]);redis.call('INCR',KEYS[4]);redis.call('EXPIRE',KEYS[4],60);return 1`;
const RELEASE=`
 local owner=redis.call('HGET',KEYS[4],ARGV[1]);if not owner then return 0 end
 redis.call('SET',KEYS[5],'1','EX',2592000);redis.call('ZREM',KEYS[1],ARGV[1]);redis.call('HDEL',KEYS[2],ARGV[1]);redis.call('HDEL',KEYS[4],ARGV[1]);
 local count=redis.call('HINCRBY',KEYS[3],owner,-1);if count<=0 then redis.call('HDEL',KEYS[3],owner) end;return 1`;
export class Admission {
 private pumping=false;
 constructor(private c:Config,private r:Redis,private q:Queue,private direction:'in'|'out'){}
 private keys(id:string,owner='') {const p=keyOf(this.c,'admit-'+this.direction);return [p+':all',p+':payload',p+':counts',p+':rate:'+digest(owner),p+':seen:'+id,p+':owners'];}
 async accept(id:string,owner:string,payload:unknown){
  const result=await this.r.eval(ADMIT,6,...this.keys(id,owner),id,owner,Date.now(),this.c.maxQueue,this.direction==='in'?2:20,this.direction==='in'?10:60,JSON.stringify(payload));
  if(Number(result)<0)throw Error('Admission quota');
  // Payload, quota and dedup reservation committed together before webhook200.
 }
 async release(id:string){const k=this.keys(id);await this.r.eval(RELEASE,5,k[0],k[1],k[2],k[5],k[4],id);}
 async expireOld(now=Date.now()){
  const k=this.keys(''),ids=await this.r.call('ZRANGEBYSCORE',k[0],'-inf',String(now-30*86400000)) as string[];
  for(const id of ids){const job=await this.q.getJob(id);if(job && await job.getState()==='active')continue;if(job)await job.remove();await this.release(id);await this.r.incr(keyOf(this.c,'expired-pending'));}
 }
 async pump(){if(this.pumping)return;this.pumping=true;try{
  const k=this.keys(''),ids=await this.r.call('ZRANGE',k[0],'0','-1') as string[];
  for(const id of ids){const job=await this.q.getJob(id);if(job){const state=await job.getState();if(state==='completed'||state==='failed')await this.release(id);continue;}
   const raw=await this.r.hget(k[1],id);if(raw)await this.q.add('message',JSON.parse(raw),{jobId:id});
  }
 }finally{this.pumping=false;}}
}
