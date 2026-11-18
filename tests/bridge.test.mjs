import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {once} from 'node:events';
import {loadConfig} from '../dist/config.js';
import {inbound,outgoing,verifyChatwoot,allowedMediaUrl,isPublicAddress} from '../dist/security.js';
import {createApp} from '../dist/app.js';
import {Bridge} from '../dist/bridge.js';
import {Chatwoot} from '../dist/chatwoot.js';
const cfg=loadConfig({BRIDGE_ENABLED:'true',MAX_BOT_TOKEN:'fixture',MAX_BOT_ID:'123',MAX_WEBHOOK_SECRET:'m'.repeat(40),CHATWOOT_API_TOKEN:'fixture',CHATWOOT_WEBHOOK_SECRET:'c'.repeat(40),CHATWOOT_INBOX_ID:'4'});
const update=(id=71)=>({update_type:'message_created',message:{sender:{user_id:id,first_name:'Fixture'},recipient:{chat_type:'dialog',chat_id:50},body:{mid:'message-'+id,text:'fixture'}}});
const reply=()=>({event:'message_created',message_type:'outgoing',private:false,account:{id:1},inbox:{id:4},id:55,conversation:{id:8},content:'reply'});
class Store {values=new Map();async get(k){return this.values.get(k)||null}async set(k,v){this.values.set(k,v);return 'OK'}}
test('required credentials and TLS verification fail closed',()=>{
  assert.throws(()=>loadConfig({BRIDGE_ENABLED:'true'}));assert.throws(()=>loadConfig({NODE_TLS_REJECT_UNAUTHORIZED:'0'}));assert.equal(loadConfig({}).enabled,false);
});
test('standard MAX sender fields preserve distinct users; skip bots/groups',()=>{
  assert.equal(inbound(update(71)).id,'71');assert.equal(inbound(update(72)).id,'72');
  const group=update();group.message.recipient.chat_type='chat';assert.equal(inbound(group),null);
  const bot=update();bot.message.sender.is_bot=true;assert.equal(inbound(bot),null);
  const invalid=update();delete invalid.message.sender;assert.throws(()=>inbound(invalid));
});
test('public outgoing filter enforces account, inbox and private flag',()=>{
  assert.equal(outgoing(reply(),1,4),true);
  for(const p of [{...reply(),private:true},{...reply(),inbox:{id:3}},{...reply(),account:{id:2}},{...reply(),message_type:'incoming'}]) assert.equal(outgoing(p,1,4),false);
});
test('Chatwoot native timestamp/raw body HMAC; mutations and expired replay rejected',()=>{
  const body=Buffer.from('{"fixture":1}'),ts=String(Math.floor(Date.now()/1000));
  const sig='sha256='+createHmac('sha256',cfg.cwSecret).update(ts+'.').update(body).digest('hex');
  assert.equal(verifyChatwoot(body,ts,sig,cfg.cwSecret),true);
  assert.equal(verifyChatwoot(Buffer.from('{}'),ts,sig,cfg.cwSecret),false);
  assert.equal(verifyChatwoot(body,ts,sig,cfg.cwSecret,Date.now()+600000),false);
});
test('media policy rejects local addresses, credentials and cross-origin redirects',()=>{
  for(const url of ['http://cdn.max.ru/a','https://127.0.0.1/a','https://evil.test/a','https://max.ru.evil.test/a','https://u:p@cdn.max.ru/a']) assert.throws(()=>allowedMediaUrl(url,{hosts:cfg.maxMediaHosts}));
  assert.throws(()=>allowedMediaUrl('https://cdn.max.ru/a',{origin:cfg.mediaOrigin}));
  assert.equal(allowedMediaUrl('https://cdn.max.ru/a',{hosts:cfg.maxMediaHosts}).hostname,'cdn.max.ru');
  for(const ip of ['127.0.0.1','10.1.1.1','172.22.0.5','169.254.169.254','::ffff:127.0.0.1','100.64.0.1']) assert.equal(isPublicAddress(ip),false);
  assert.equal(isPublicAddress('8.8.8.8'),true);
});
test('webhook rejects invalid auth, fails when queue unavailable, skips private notes',async()=>{
  let jobs=[];let fail=false;
  const server=createApp(cfg,async(...job)=>{if(fail)throw Error();jobs.push(job)},async()=>true).listen(0,'127.0.0.1');await once(server,'listening');
  try {
    const base='http://127.0.0.1:'+server.address().port;
    const send=(path,p,headers={})=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(p)});
    assert.equal((await send('/max-webhook',update())).status,401);
    const auth={'X-Max-Bot-Api-Secret':cfg.maxSecret};assert.equal((await send('/max-webhook',update(),auth)).status,200);assert.equal(jobs.length,1);
    fail=true;assert.equal((await send('/max-webhook',update(72),auth)).status,503);
    const p={...reply(),private:true},body=JSON.stringify(p),ts=String(Math.floor(Date.now()/1000));
    const signature='sha256='+createHmac('sha256',cfg.cwSecret).update(ts+'.'+body).digest('hex');
    assert.equal((await send('/chatwoot-webhook',p,{'X-Chatwoot-Timestamp':ts,'X-Chatwoot-Signature':signature})).status,200);assert.equal(jobs.length,1);
  } finally {await new Promise(r=>server.close(r));}
});
test('incoming failure is retryable; accepted request is reconciled after receipt loss',async()=>{
  const store=new Store(),bridge=new Bridge(cfg,store);let delivered=false,calls=0;
  bridge.cw.call=async()=>({status:'open'});bridge.cw.contact=async()=>({id:9,source:'canonical'});bridge.cw.conversation=async()=>8;
  bridge.cw.findMessage=async()=>delivered?99:null;
  bridge.cw.incoming=async()=>{calls++;delivered=true;throw Error('simulated lost HTTP response')};
  await assert.rejects(()=>bridge.incoming(update()));assert.equal([...store.values.keys()].some(k=>k.startsWith('received-')),false);
  await bridge.incoming(update());await bridge.incoming(update());assert.equal(calls,1);
});
test('MAX outbound ambiguous timeout is parked, not resent; confirmed duplicate skipped',async()=>{
  const store=new Store();await store.set('recipient-8','71');const bridge=new Bridge(cfg,store);let calls=0;
  bridge.bot.api.sendMessageToUser=async()=>{calls++;throw Error('simulated timeout')};
  await assert.rejects(()=>bridge.outgoing(reply()));assert.equal(await store.get('sent-55'),'uncertain');await assert.rejects(()=>bridge.outgoing(reply()));assert.equal(calls,1);
  await store.set('sent-55','sent:known');await bridge.outgoing(reply());assert.equal(calls,1);
});
test('MAX 429 remains retryable and success stores a receipt',async()=>{
  const store=new Store();await store.set('recipient-8','71');const bridge=new Bridge(cfg,store);let calls=0;
  bridge.bot.api.sendMessageToUser=async()=>{if(++calls===1)throw {status:429};return {body:{mid:'max-receipt'}}};
  await assert.rejects(()=>bridge.outgoing(reply()));assert.equal(await store.get('sent-55'),'retry');await bridge.outgoing(reply());assert.equal(await store.get('sent-55'),'sent:max-receipt');
});
test('contact link reuses canonical source ID supplied by Chatwoot',async()=>{
  const cw=new Chatwoot(cfg);let created;
  cw.call=async(path,method,body)=>{
    if(path==='/contacts/filter') return {payload:[{id:9,identifier:'max:123:71',contact_inboxes:[{inbox:{id:4},source_id:'canonical-link'}]}]};
    if(path==='/contacts/9/conversations')return {payload:[]};
    if(path==='/conversations'){created=body;return {id:8}};throw Error('unexpected');
  };
  const contact=await cw.contact('71','fixture');await cw.conversation(contact);assert.equal(created.source_id,'canonical-link');assert.equal(created.contact_id,9);
});
