import {withDeadline} from './deadline.js';
import express from 'express';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {loadConfig,type Config} from './config.js';
import {Chatwoot as TrustedChatwoot} from './trusted-chatwoot.js';
import {equalSecret,report} from './security.js';
import {scopeOf} from './scope.js';
import {downloadChatwoot} from './http.js';
export class Gateway {
 readonly cw:TrustedChatwoot;readonly db:DatabaseSync;
 constructor(readonly cfg:Config,path:string) {
  mkdirSync(dirname(path),{recursive:true,mode:0o700});this.db=new DatabaseSync(path);
  this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS config(id INTEGER PRIMARY KEY,scope TEXT); CREATE TABLE IF NOT EXISTS receipts(source TEXT PRIMARY KEY,conversation INTEGER,floor INTEGER,result INTEGER,created INTEGER NOT NULL DEFAULT(unixepoch()));');
  this.db.prepare('INSERT OR IGNORE INTO config VALUES(1,?)').run(scopeOf(cfg));
  if(this.db.prepare('SELECT scope FROM config WHERE id=1').get()?.scope!==scopeOf(cfg)){this.db.close();throw Error('Gateway configuration fingerprint mismatch');}
  this.db.prepare('DELETE FROM receipts WHERE result IS NOT NULL AND created < ?').run(Math.floor(Date.now()/1000)-30*86400);
  this.cw=new TrustedChatwoot(cfg);
 }
 async contact(user:string,name='MAX user') {
  const c=await this.cw.contact(user,name.slice(0,120));
  const full=(await this.cw.call(`/contacts/${c.id}`)).payload;
  if(full.identifier!==`max:${this.cfg.maxBotId||'unconfigured'}:${user}` || !full.contact_inboxes?.length || full.contact_inboxes.some((x:any)=>Number(x.inbox?.id)!==this.cfg.inbox))throw Error('Contact outside MAX scope');
  return {...c,user};
 }
 async check(id:number,user:string) {
  const contact=await this.contact(user);const c=await this.cw.call(`/conversations/${id}`);
  if(Number(c.inbox_id)!==this.cfg.inbox || Number(c.meta?.sender?.id ?? c.contact_id)!==contact.id)throw Error('Conversation ownership mismatch');
  return {id,inbox_id:this.cfg.inbox,contact_id:contact.id,status:c.status};
 }
 async rpc(p:any) {
  if(!['validate','contact','conversation','check','incoming','note','attachment'].includes(p.op))throw Error('Unsupported operation');
  if(p.op==='validate'){await this.cw.validate();return {account:this.cfg.account,inbox:this.cfg.inbox};}
  if(typeof p.user!=='string'||!/^[1-9]\d{0,15}$/.test(p.user))throw Error('Invalid user');
  if(p.op==='contact')return this.contact(p.user,typeof p.name==='string'?p.name:'MAX user');
  if(p.op==='conversation'){const c=await this.contact(p.user);const id=await this.cw.conversation(c);await this.check(id,p.user);return {id};}
  if(!Number.isSafeInteger(p.conversation)||p.conversation<1)throw Error('Invalid conversation');
  const owned=await this.check(p.conversation,p.user);
  if(p.op==='check')return owned;
  if(p.op==='note'){if(typeof p.text!=='string'||p.text.length>1000)throw Error('Invalid note');await this.cw.note(p.conversation,p.text);return {ok:true};}
  if(p.op==='attachment'){
   if(!Number.isSafeInteger(p.message)||!Number.isSafeInteger(p.attachment))throw Error('Invalid attachment');
   const page=await this.cw.call(`/conversations/${p.conversation}/messages?before=${p.message+1}`);
   const m=page.payload.find((x:any)=>x.id===p.message),a=m?.attachments?.find((x:any)=>x.id===p.attachment);
   if(!a||m.private!==false||![1,3,'outgoing','template'].includes(m.message_type))throw Error('Attachment outside public outgoing message');
   const f=await downloadChatwoot(a.data_url,this.cfg.mediaOrigin,this.cfg.cwUrl,this.cfg.maxBytes);return {data:f.data.toString('base64'),type:f.type};
  }
  if(p.op!=='incoming'||typeof p.source!=='string'||!p.source.startsWith(`max:${scopeOf(this.cfg)}:${p.user}:`)||p.source.length>256||typeof p.text!=='string'||p.text.length>10000||!Array.isArray(p.files)||p.files.length>10)throw Error('Invalid incoming operation');
  let receipt=this.db.prepare('SELECT * FROM receipts WHERE source=?').get(p.source);
  if(receipt && receipt.conversation!==p.conversation)throw Error('Receipt ownership mismatch');
  if(receipt?.result)return {id:receipt.result};
  if(receipt){const existing=await this.cw.findMessage(p.conversation,p.source,Number(receipt.floor));if(existing){this.db.prepare('UPDATE receipts SET result=? WHERE source=?').run(existing,p.source);return {id:existing};}}
  else {
   const page=await this.cw.call(`/conversations/${p.conversation}/messages`);const floor=Math.max(0,...page.payload.map((m:any)=>Number(m.id)));
   this.db.prepare('INSERT INTO receipts(source,conversation,floor,result) VALUES(?,?,?,NULL)').run(p.source,p.conversation,floor);
  }
  let bytes=0;const files=p.files.map((f:any)=>{if(typeof f.data!=='string'||typeof f.name!=='string'||typeof f.type!=='string')throw Error('Invalid file');const data=Buffer.from(f.data,'base64');bytes+=data.length;if(bytes>this.cfg.maxBytes)throw Error('File budget');return {data,name:f.name.slice(0,100),type:f.type.slice(0,100)};});
  if(owned.status==='resolved')await this.cw.call(`/conversations/${p.conversation}/toggle_status`,'POST',{status:'open'});
  const id=await this.cw.incoming(p.conversation,p.source,p.text,files,true);
  this.db.prepare('UPDATE receipts SET result=? WHERE source=?').run(id,p.source);return {id};
 }
}
export function gatewayApp(cfg:Config,gateway:Gateway) {
 const app=express();app.disable('x-powered-by');let busy=0,running=false;
 const pending:{q:any;s:any;controller:AbortController;release:()=>void}[]=[];
 const drain=()=>{
  if(running)return;const task=pending.shift();if(!task)return;running=true;
  const signal=AbortSignal.any([task.controller.signal,AbortSignal.timeout(30000)]);
  void withDeadline(signal,()=>gateway.rpc(task.q.body)).then(value=>{if(!task.s.destroyed)task.s.json(value);},()=>{if(!task.s.destroyed)task.s.sendStatus(403);}).finally(()=>{task.release();running=false;drain();});
 };
 app.get('/health',(_q,s)=>s.json({mode:'gateway',scope:scopeOf(cfg)}));
 app.use((q,s,n)=>{
  if(!equalSecret(q.headers.authorization,'Bearer '+cfg.gatewayToken)||q.headers['x-bridge-scope']!==scopeOf(cfg)){s.sendStatus(401);return;}
  if(busy>=4){s.sendStatus(429);return;}busy++;let released=false,scheduled=false;
  const release=()=>{if(!released){released=true;busy--;}};
  s.locals.permit={release,schedule:()=>{scheduled=true;}};
  s.once('close',()=>{if(!scheduled)release();});s.once('finish',()=>{if(!scheduled)release();});n();
 });
 app.use(express.json({limit:'15mb',inflate:false}));
 app.post('/rpc',(q,s)=>{
  const {release,schedule}=s.locals.permit;schedule();const task={q,s,controller:new AbortController(),release};
  s.once('close',()=>{if(s.writableFinished)return;task.controller.abort();const i=pending.indexOf(task);if(i>=0){pending.splice(i,1);task.q.body=null;release();}});
  pending.push(task);drain();
 });
 app.use((_e:any,_q:any,s:any,_n:any)=>s.sendStatus(400));return app;
}
if(process.argv[1]?.endsWith('/gateway.js')) {
 try{const cfg=loadConfig({...process.env,BRIDGE_ENABLED:'false'});if(!cfg.cwToken||cfg.gatewayToken.length<32)throw Error();const path=process.env.GATEWAY_DB||'/data/gateway.sqlite';
 if(process.argv.includes('--rebind-empty')){const db=new DatabaseSync(path);if(Number(db.prepare('SELECT count(*) AS n FROM receipts').get()?.n)!==0)throw Error('Gateway has receipts');db.prepare('UPDATE config SET scope=? WHERE id=1').run(scopeOf(cfg));db.close();process.exit(0);}
 const g=new Gateway(cfg,path);const server=gatewayApp(cfg,g).listen(3000,'0.0.0.0',()=>report('gateway_ready'));server.maxConnections=16;server.maxRequestsPerSocket=100;server.requestTimeout=10000;server.headersTimeout=10000;}
 catch{report('gateway_startup_failed');process.exit(1);}
}
