import { Bot } from '@maxhub/max-bot-api';
import { UnrecoverableError } from 'bullmq';
import type { Config } from './config.js';
import type { Redis } from 'ioredis';
import { Chatwoot } from './chatwoot.js';
import { HttpFailure, download, downloadChatwoot } from './http.js';
import { inbound, digest } from './security.js';
export class Bridge {
  readonly cw:Chatwoot;readonly bot:Bot;
  private nextApiAt=0;
  constructor(readonly cfg:Config,readonly redis:Redis) {
    this.cw=new Chatwoot(cfg);
    this.bot=new Bot(cfg.maxToken,{clientOptions:{baseUrl:'https://platform-api2.max.ru',fetch:async(input,init)=>{
      const now=Date.now(),wait=Math.max(0,this.nextApiAt-now);this.nextApiAt=Math.max(now,this.nextApiAt)+100;
      if(wait) await new Promise(r=>setTimeout(r,wait));
      return fetch(input,{...init,redirect:'error',signal:AbortSignal.timeout(15000)});
    }}});
  }
  async validate() {
    const me=await this.bot.api.getMyInfo();
    if(String(me.user_id)!==this.cfg.maxBotId) throw new Error('Unexpected MAX bot');
    await this.cw.validate();
  }
  async incoming(payload:any) {
    const m=inbound(payload);if(!m) return;
    const source=`max:${this.cfg.maxBotId}:${m.mid}`;
    if(await this.redis.get('received-'+digest(source))) return;
    const contact=await this.cw.contact(m.id,m.name);
    let conversation=Number(await this.redis.get('conversation-'+m.id));
    if(conversation) {
      try {const c=await this.cw.call(`/conversations/${conversation}`);if(c.status==='resolved') await this.cw.call(`/conversations/${conversation}/toggle_status`,'POST',{status:'open'});}
      catch(e) {if(e instanceof HttpFailure && e.status===404) conversation=0;else throw e;}
    }
    if(!conversation) {conversation=await this.cw.conversation(contact);await this.redis.set('conversation-'+m.id,String(conversation));}
    await this.redis.set('recipient-'+conversation,m.id);
    // Reconcile a possibly accepted previous request before downloading media.
    if(await this.cw.findMessage(conversation,source)) {await this.redis.set('received-'+digest(source),'1','EX',30*86400);return;}
    const files:{data:Buffer;type:string;name:string}[]=[];const notes:string[]=[];
    if(!Array.isArray(m.attachments)||m.attachments.length>10) throw new UnrecoverableError('Attachment count limit');
    for(const a of m.attachments) {
      if(!['image','file','audio','video'].includes(a.type)||!a.payload?.url) {notes.push('[Вложение MAX недоступно для передачи]');continue;}
      const f=await download(a.payload.url,{hosts:this.cfg.maxMediaHosts},this.cfg.maxBytes);
      if(files.reduce((sum,f)=>sum+f.data.length,0)+f.data.length>this.cfg.maxBytes) throw new UnrecoverableError('Combined attachment limit');
      files.push({...f,name:String(a.filename||a.payload.filename||'attachment').replace(/[^\p{L}\p{N}._-]/gu,'_').slice(0,100)});
    }
    await this.cw.incoming(conversation,source,[m.text,...notes].filter(Boolean).join('\n'),files);
    // Mark done only AFTER successful delivery (or reconciliation), not before it.
    await this.redis.set('received-'+digest(source),'1','EX',30*86400);
  }
  async outgoing(payload:any) {
    const key='sent-'+payload.id;
    const state=await this.redis.get(key);
    if(state?.startsWith('sent:')) return;
    if(['sending','uncertain','failed'].includes(state||'')) throw new UnrecoverableError('Delivery requires reconciliation');
    const user=await this.redis.get('recipient-'+payload.conversation.id);
    if(!user || !/^\d+$/.test(user)) throw new UnrecoverableError('Recipient mapping missing');
    const text=typeof payload.content==='string'?payload.content:'';
    if(text.length>4000) throw new UnrecoverableError('MAX text limit');
    const attachments:any[]=[];
    if((payload.attachments||[]).length>10) throw new UnrecoverableError('Attachment count limit');
    for(const a of payload.attachments||[]) {
      const f=await downloadChatwoot(a.data_url,this.cfg.mediaOrigin,this.cfg.cwUrl,this.cfg.maxBytes);
      // The SDK receives a bounded buffer, never an arbitrary download URL.
      const upload=a.file_type==='image'?await this.bot.api.uploadImage({source:f.data,timeout:20000}):await this.bot.api.uploadFile({source:f.data,timeout:20000});
      attachments.push(upload);
    }
    if(!text && !attachments.length) return;
    await this.redis.set(key,'sending','EX',30*86400);
    try {
      const result=await this.bot.api.sendMessageToUser(Number(user),text,{attachments});
      const mid=result.body?.mid;
      if(!mid) throw new Error('Missing receipt');
      await this.redis.set(key,'sent:'+mid,'EX',30*86400);
    } catch(error:any) {
      const status=error?.status ?? error?.response?.status;
      if(status===429) {await this.redis.set(key,'retry','EX',30*86400);throw new Error('MAX rate limit');}
      // A timeout/crash may occur after MAX accepted a message. Never blindly
      // resend it: retain an uncertain receipt and notify the operator.
      await this.redis.set(key,status>=400 && status<500?'failed':'uncertain','EX',30*86400);
      throw new UnrecoverableError('MAX delivery not confirmed');
    }
  }
}
