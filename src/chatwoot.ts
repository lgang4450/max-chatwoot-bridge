import type { Config } from './config.js';
import { FormData } from 'undici';
import { api } from './http.js';
export class Chatwoot {
  constructor(private cfg: Config) {}
  call(path:string, method='GET', body?:unknown) {
    return api(`${this.cfg.cwUrl}/api/v1/accounts/${this.cfg.account}${path}`,method,body,{'api_access_token':this.cfg.cwToken,'X-Forwarded-Proto':'https'});
  }
  async validate() {
    const inbox=await this.call(`/inboxes/${this.cfg.inbox}`);
    if(inbox.channel_type!=='Channel::Api') throw new Error('API inbox required');
  }
  async contact(user:string,name:string) {
    const identifier=`max:${this.cfg.maxBotId}:${user}`;
    const find=async()=>{
      const r=await this.call('/contacts/filter','POST',{payload:[{attribute_key:'identifier',filter_operator:'equal_to',values:[identifier],query_operator:null}]});
      return (r.payload||[]).find((x:any)=>x.identifier===identifier);
    };
    let contact=await find();
    if(!contact) {
      try {const r=await this.call('/contacts','POST',{inbox_id:this.cfg.inbox,identifier,name,additional_attributes:{max_user_id:user,max_bot_id:this.cfg.maxBotId}});contact=r.payload?.contact;}
      catch(error) {contact=await find();if(!contact) throw error;}
    }
    if(!contact?.id) throw new Error('Contact missing');
    // A contact can exist after an interrupted earlier attempt; always use the
    // source_id returned by this inbox, never synthesize one from a MAX user ID.
    let link=contact.contact_inboxes?.find((x:any)=>Number(x.inbox?.id)===this.cfg.inbox);
    if(!link) {
      const detail=await this.call(`/contacts/${contact.id}`);
      link=(detail.payload?.contact||detail.payload||detail).contact_inboxes?.find((x:any)=>Number(x.inbox?.id)===this.cfg.inbox);
    }
    if(!link) link=await this.call(`/contacts/${contact.id}/contact_inboxes`,'POST',{inbox_id:this.cfg.inbox});
    if(!link.source_id) throw new Error('Contact inbox missing');
    return {id:contact.id,source:link.source_id};
  }
  async conversation(contact:{id:number;source:string}) {
    const list=await this.call(`/contacts/${contact.id}/conversations`);
    const found=(list.payload||[]).filter((x:any)=>Number(x.inbox_id)===this.cfg.inbox && x.status!=='resolved').sort((a:any,b:any)=>b.id-a.id)[0];
    if(found) return found.id as number;
    const created=await this.call('/conversations','POST',{inbox_id:this.cfg.inbox,contact_id:contact.id,source_id:contact.source,status:'open'});
    if(!Number.isSafeInteger(created.id)) throw new Error('Conversation missing');
    return created.id as number;
  }
  async findMessage(conversation:number,source:string) {
    let before:number|undefined;
    for(let page=0;page<250;page++) {
      const r=await this.call(`/conversations/${conversation}/messages${before?'?before='+before:''}`);
      const messages=r.payload;
      if(!Array.isArray(messages)) throw new Error('Invalid message page');
      const found=messages.find((x:any)=>x.source_id===source);
      if(found) return found.id as number;
      if(!messages.length) return null;
      const next=Math.min(...messages.map((x:any)=>x.id));
      if(!Number.isSafeInteger(next)|| next===before) throw new Error('Invalid pagination');
      before=next;
    }
    throw new Error('Reconciliation page limit');
  }
  async incoming(conversation:number,source:string,text:string,files:{data:Buffer;type:string;name:string}[]) {
    const existing=await this.findMessage(conversation,source);
    if(existing) return existing;
    const form=new FormData();form.set('content',text);form.set('message_type','incoming');form.set('source_id',source);
    for(const f of files) form.append('attachments[]',new Blob([new Uint8Array(f.data)],{type:f.type}),f.name);
    const r=await this.call(`/conversations/${conversation}/messages`,'POST',form);
    if(!Number.isSafeInteger(r.id)) throw new Error('Message missing');
    return r.id as number;
  }
  async note(conversation:number,text:string) {return this.call(`/conversations/${conversation}/messages`,'POST',{content:text,message_type:'outgoing',private:true});}
}
