import type {Config} from './config.js';
import type {Message} from '@maxhub/max-bot-api/types';
import {api,uploadPublic} from './http.js';
// SDK declarations are compile-time only. Runtime transport is bounded and never
// executes SDK debug logging or its separate uncontrolled upload client.
export class MaxApi {
 private next=0;
 constructor(private cfg:Config){}
 private async call(path:string,method='GET',body?:unknown){const now=Date.now(),wait=Math.max(0,this.next-now);this.next=Math.max(now,this.next)+100;if(wait)await new Promise(r=>setTimeout(r,wait));return api('https://platform-api2.max.ru'+path,method,body,{Authorization:this.cfg.maxToken});}
 getMyInfo(){return this.call('/me');}
 getSubscriptions(){return this.call('/subscriptions').then(r=>r.subscriptions as {url:string}[]);}
 subscribe(url:string,secret:string,update_types:string[]){return this.call('/subscriptions','POST',{url,secret,update_types});}
 async sendMessageToUser(user_id:number,text:string,extra:any):Promise<Message>{const r=await this.call('/messages?user_id='+user_id,'POST',{text,...extra});return r.message||r;}
 private async upload(data:Buffer,image:boolean){
  if(data.length>this.cfg.maxBytes)throw Error('Upload budget');
  const r=await this.call('/uploads?type='+(image?'image':'file'),'POST');
  const result=await uploadPublic(r.url,this.cfg.maxMediaHosts,data,image);
  if(image&&result.photos)return {type:'image',payload:{photos:result.photos}};
  const token=result.token||r.token;if(typeof token!=='string')throw Error('Upload receipt missing');
  return {type:image?'image':'file',payload:{token}};
 }
 uploadImage(options:{source:Buffer;timeout?:number}){return this.upload(options.source,true);}
 uploadFile(options:{source:Buffer;timeout?:number}){return this.upload(options.source,false);}
}
