import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Gateway,gatewayApp} from '../dist/gateway.js';
import {Bridge} from '../dist/bridge.js';
import {loadConfig} from '../dist/config.js';
import {scopeOf,keyOf,queueName} from '../dist/scope.js';
import {once} from 'node:events';
const cfg=loadConfig({GATEWAY_TOKEN:'g'.repeat(40),MAX_BOT_TOKEN:'fixture',MAX_BOT_ID:'123',MAX_WEBHOOK_SECRET:'m'.repeat(40),CHATWOOT_WEBHOOK_SECRET:'c'.repeat(40),CHATWOOT_INBOX_ID:'4'});
class Store{values=new Map;async get(k){return this.values.get(k)||null}async set(k,v){this.values.set(k,v)}}
test('bridge settings reject broad application credentials',()=>{
 assert.throws(()=>loadConfig({CHATWOOT_API_TOKEN:'broad'}));
});
test('queue/key namespaces separate account, inbox and bot',()=>{
 for(const c of [{...cfg,account:2},{...cfg,inbox:5},{...cfg,maxBotId:'200'}]){assert.notEqual(keyOf(cfg,'x'),keyOf(c,'x'));assert.notEqual(queueName(cfg,'in'),queueName(c,'in'));}
});
test('stale conversation belonging to another contact cannot replace recipient or receive incoming',async()=>{
 const c={...cfg,account:2,maxBotId:'200'},r=new Store;await r.set(keyOf(c,'conversation-71'),'8');await r.set(keyOf(c,'recipient-8'),'72');
 const b=new Bridge(c,r);b.cw.contact=async()=>({id:999,user:'71',source:'canonical'});b.cw.check=async()=>({contact_id:22,inbox_id:4});b.cw.incoming=async()=>assert.fail('Foreign write');
 await assert.rejects(()=>b.incoming({update_type:'message_created',message:{sender:{user_id:71},recipient:{chat_type:'dialog'},body:{mid:'fixture',text:'hi'}}}));
 assert.equal(await r.get(keyOf(c,'recipient-8')),'72');
});
test('gateway denies email contact, foreign inbox and foreign contact even with valid bridge credential',async()=>{
 const g=new Gateway(cfg,':memory:');g.cw.contact=async()=>({id:3,source:'link'});g.cw.call=async()=>({payload:{identifier:'email-user',contact_inboxes:[{inbox:{id:2}}]}});
 await assert.rejects(()=>g.rpc({op:'contact',user:'71'}));
 g.cw.contact=async()=>({id:9,source:'link'});g.cw.call=async p=>p.startsWith('/contacts/')?{payload:{identifier:'max:123:71',contact_inboxes:[{inbox:{id:4}}]}}:{inbox_id:2,contact_id:9};
 await assert.rejects(()=>g.rpc({op:'note',user:'71',conversation:8,text:'forbidden'}));
 g.cw.call=async p=>p.startsWith('/contacts/')?{payload:{identifier:'max:123:71',contact_inboxes:[{inbox:{id:4}}]}}:{inbox_id:4,contact_id:22};
 await assert.rejects(()=>g.rpc({op:'check',user:'71',conversation:8}));g.db.close();
});
test('gateway HTTP has no raw contact read/update endpoint, rejects wrong configuration',async()=>{
 const g=new Gateway(cfg,':memory:'),s=gatewayApp(cfg,g).listen(0,'127.0.0.1');await once(s,'listening');
 try{const url='http://127.0.0.1:'+s.address().port,headers={Authorization:'Bearer '+cfg.gatewayToken,'X-Bridge-Scope':scopeOf(cfg)};
 for(const method of ['GET','PATCH'])assert.equal((await fetch(url+'/api/v1/accounts/1/contacts/3',{method,headers})).status,404);
 assert.equal((await fetch(url+'/rpc',{method:'POST',headers:{...headers,'X-Bridge-Scope':scopeOf({...cfg,inbox:2})}})).status,401);
 }finally{await new Promise(r=>s.close(r));g.db.close();}
});
test('gateway owns durable receipts and bounded reconciliation after lost upstream response',async()=>{
 const g=new Gateway(cfg,':memory:');let delivered=false,writes=0,scans=0;
 g.check=async()=>({id:8,inbox_id:4,contact_id:9,status:'open'});g.cw.call=async()=>({payload:[]});
 g.cw.findMessage=async(_c,_s,floor)=>{scans++;assert.equal(floor,0);return delivered?99:null};
 g.cw.incoming=async()=>{writes++;delivered=true;throw Error('lost response')};
 const p={op:'incoming',user:'71',conversation:8,source:`max:${scopeOf(cfg)}:71:fixture`,text:'fixture',files:[]};
 await assert.rejects(()=>g.rpc(p));assert.equal(writes,1);assert.equal(scans,0);
 assert.equal((await g.rpc(p)).id,99);assert.equal((await g.rpc(p)).id,99);assert.equal(writes,1);assert.equal(scans,1);g.db.close();
});
test('persistent gateway fingerprint refuses restored state from another configuration',()=>{
 const dir=mkdtempSync(join(tmpdir(),'gw-scope-')),path=join(dir,'state.sqlite');const g=new Gateway(cfg,path);g.db.close();
 try{assert.throws(()=>new Gateway({...cfg,maxBotId:'200'},path));}finally{rmSync(dir,{recursive:true});}
});
test('gateway attachment denies private/incoming/activity, permits only public outgoing numeric enum',async()=>{
 const g=new Gateway(cfg,':memory:');g.check=async()=>({id:8,inbox_id:4,contact_id:9,status:'open'});
 for(const [type,privateFlag] of [[1,true],[0,false],[2,false]]){
  g.cw.call=async()=>({payload:[{id:55,message_type:type,private:privateFlag,attachments:[{id:77,data_url:'https://support.example.com/rails/active_storage/blob'}]}]});
  await assert.rejects(()=>g.rpc({op:'attachment',user:'71',conversation:8,message:55,attachment:77}));
 }g.db.close();
});
test('aborted queued gateway RPCs are removed; active request retains its permit',async()=>{
 const {withDeadline}=await import('../dist/deadline.js');let release,calls=0;
 const blocked=new Promise(r=>release=r),fake={rpc:async()=>{calls++;await blocked;return {ok:true}}};
 const s=gatewayApp(cfg,fake).listen(0,'127.0.0.1');await once(s,'listening');
 const url='http://127.0.0.1:'+s.address().port+'/rpc',headers={Authorization:'Bearer '+cfg.gatewayToken,'X-Bridge-Scope':scopeOf(cfg),'Content-Type':'application/json'};
 const first=fetch(url,{method:'POST',headers,body:'{}'});
 try{for(let i=0;i<8;i++){const c=new AbortController();const request=fetch(url,{method:'POST',headers,body:'{}',signal:c.signal}).catch(()=>{});await new Promise(r=>setTimeout(r,10));c.abort();await request;}
  await new Promise(r=>setTimeout(r,30));release();await first;await new Promise(r=>setTimeout(r,30));assert.equal(calls,1);
 }finally{release();await new Promise(r=>s.close(r));}
});
test('JSON response cap stops streaming before full allocation; debug env rejected',async()=>{
 const {readBounded,uploadPublic}=await import('../dist/http.js');let pulled=0,cancelled=false;
 const response=new Response(new ReadableStream({pull(c){pulled++;c.enqueue(new Uint8Array(128));},cancel(){cancelled=true;}}));
 await assert.rejects(()=>readBounded(response,256));assert.ok(pulled<10);assert.equal(cancelled,true);
 await assert.rejects(()=>uploadPublic('http://127.0.0.1/upload',['max.ru'],Buffer.from('fixture'),true));
 assert.throws(()=>loadConfig({DEBUG:'max:client'}));assert.throws(()=>loadConfig({NODE_DEBUG:'http'}));
});
test('foreign contact is rejected before creating any MAX contact-inbox link',async()=>{
 const {Chatwoot}=await import('../dist/trusted-chatwoot.js');const cw=new Chatwoot(cfg);let writes=0;
 cw.call=async(path,method)=>{if(method==='POST' && path!=='/contacts/filter')writes++;return {payload:[{id:3,identifier:'max:123:71',contact_inboxes:[{inbox:{id:2},source_id:'email'}]}]};};
 await assert.rejects(()=>cw.contact('71','fixture'));assert.equal(writes,0);
});
