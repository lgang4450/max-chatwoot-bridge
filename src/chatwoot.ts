import type {Config} from './config.js';
import {api} from './http.js';
import {scopeOf} from './scope.js';
export class Chatwoot {
 constructor(private cfg:Config) {}
 rpc(op:string,body:unknown={}) {return api(this.cfg.cwUrl+'/rpc','POST',{op,...body as object},{Authorization:'Bearer '+this.cfg.gatewayToken,'X-Bridge-Scope':scopeOf(this.cfg)},op==='attachment'?Math.ceil(this.cfg.maxBytes*4/3)+4096:4*1024*1024);}
 validate(){return this.rpc('validate');}
 contact(user:string,name:string){return this.rpc('contact',{user,name});}
 conversation(contact:{user:string;id:number;source:string}){return this.rpc('conversation',{user:contact.user}).then(r=>r.id as number);}
 check(conversation:number,user:string){return this.rpc('check',{conversation,user});}
 incoming(conversation:number,source:string,text:string,files:{data:Buffer;type:string;name:string}[],user:string){return this.rpc('incoming',{conversation,source,text,user,files:files.map(f=>({...f,data:f.data.toString('base64')}))}).then(r=>r.id as number);}
 note(conversation:number,text:string,user:string){return this.rpc('note',{conversation,text,user});}
 async attachment(conversation:number,message:number,attachment:number,user:string){const r=await this.rpc('attachment',{conversation,message,attachment,user});return {data:Buffer.from(r.data,'base64'),type:r.type as string};}
}
