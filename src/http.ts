import {requestSignal} from './deadline.js';
import { lookup } from 'node:dns/promises';
import { Agent, fetch, FormData } from 'undici';
import { allowedMediaUrl, isPublicAddress } from './security.js';
export class HttpFailure extends Error { constructor(public status=0) { super('Transport failure'); } }
export async function api(url: string, method='GET', body?: unknown, headers: Record<string,string>={},limit=4*1024*1024) {
  const form = body instanceof FormData;
  const response = await fetch(url,{method,headers:{...(!form && body!==undefined?{'Content-Type':'application/json'}:{}),...headers},body:body===undefined?undefined:form?body:JSON.stringify(body),redirect:'error',signal:requestSignal(15000)});
  if (!response.ok) { await response.body?.cancel(); throw new HttpFailure(response.status); }
  const raw=await readBounded(response,limit);
  try{return raw.length?JSON.parse(raw.toString()):{};}catch{throw new HttpFailure();}
}
export async function download(raw: string, policy: {origin?:string;hosts?:string[]}, maxBytes: number): Promise<{data:Buffer;type:string}> {
  let url=allowedMediaUrl(raw,policy);
  for(let redirects=0; redirects<=3; redirects++) {
    const addresses=await lookup(url.hostname,{all:true,family:4});
    if(!addresses.length || addresses.some(a=>!isPublicAddress(a.address))) throw new HttpFailure();
    const pinned=addresses[0];
    const agent=new Agent({connect:{lookup:((_h:any,_o:any,cb:any)=>_o.all?cb(null,[pinned]):cb(null,pinned.address,4)) as any}});
    try {
      const response=await fetch(url,{dispatcher:agent,redirect:'manual',signal:requestSignal(20000)});
      if([301,302,303,307,308].includes(response.status)) {
        const location=response.headers.get('location');await response.body?.cancel();
        if(!location) throw new HttpFailure();
        url=allowedMediaUrl(new URL(location,url).href,policy);continue;
      }
      if(!response.ok || Number(response.headers.get('content-length')||0)>maxBytes) {await response.body?.cancel();throw new HttpFailure(response.status);}
      let total=0;const chunks:Buffer[]=[];
      for await(const chunk of response.body!) {total+=chunk.length;if(total>maxBytes) {await response.body?.cancel().catch(()=>{});throw new HttpFailure();}chunks.push(Buffer.from(chunk));}
      return {data:Buffer.concat(chunks),type:response.headers.get('content-type')||'application/octet-stream'};
    } finally {await agent.close();}
  }
  throw new HttpFailure();
}

// Signed ActiveStorage links may be behind staff Basic Auth at the public edge.
// Rewrite only this path namespace to the operator-configured Chatwoot origin.
// Private-address access is limited to that single trusted service, not payload URLs.
export async function downloadChatwoot(raw:string,publicOrigin:string,internalOrigin:string,maxBytes:number) {
  let path=allowedMediaUrl(raw,{origin:publicOrigin});
  const local=new URL(internalOrigin);
  for(let redirects=0;redirects<=3;redirects++) {
    if(!path.pathname.startsWith('/rails/active_storage/')) throw new HttpFailure();
    const target=new URL(path.pathname+path.search,local);
    const response=await fetch(target,{redirect:'manual',headers:{'X-Forwarded-Host':new URL(publicOrigin).host,'X-Forwarded-Proto':'https'},signal:requestSignal(20000)});
    if([301,302,303,307,308].includes(response.status)) {
      const location=response.headers.get('location');await response.body?.cancel();
      if(!location) throw new HttpFailure();
      path=allowedMediaUrl(new URL(location,path).href,{origin:publicOrigin});continue;
    }
    if(!response.ok || Number(response.headers.get('content-length')||0)>maxBytes) {await response.body?.cancel();throw new HttpFailure(response.status);}
    const chunks:Buffer[]=[];let total=0;
    for await(const chunk of response.body!) {total+=chunk.length;if(total>maxBytes)throw new HttpFailure();chunks.push(Buffer.from(chunk));}
    return {data:Buffer.concat(chunks),type:response.headers.get('content-type')||'application/octet-stream'};
  }
  throw new HttpFailure();
}

export async function readBounded(response:any,limit:number):Promise<Buffer> {
 if(Number(response.headers.get('content-length')||0)>limit){await response.body?.cancel();throw new HttpFailure();}
 const reader=response.body?.getReader();if(!reader)return Buffer.alloc(0);const chunks:Buffer[]=[];let bytes=0;
 try {while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>limit){await reader.cancel();throw new HttpFailure();}chunks.push(Buffer.from(value));}return Buffer.concat(chunks);}
 finally{reader.releaseLock();}
}
export async function uploadPublic(raw:string,hosts:string[],data:Buffer,image:boolean) {
 const url=allowedMediaUrl(raw,{hosts});const addresses=await lookup(url.hostname,{all:true,family:4});
 if(!addresses.length||addresses.some(a=>!isPublicAddress(a.address)))throw new HttpFailure();
 const pinned=addresses[0],agent=new Agent({connect:{lookup:((_h:any,o:any,cb:any)=>o.all?cb(null,[pinned]):cb(null,pinned.address,4)) as any}});
 try {
  const form=new FormData();form.append('data',new Blob([new Uint8Array(data)]),image?'image':'file');
  const r=await fetch(url,{method:'POST',body:form,dispatcher:agent,redirect:'error',signal:requestSignal(20000)});
  if(!r.ok){await r.body?.cancel();throw new HttpFailure(r.status);}
  const raw=await readBounded(r,1024*1024);try{return JSON.parse(raw.toString());}catch{throw new HttpFailure();}
 }finally{await agent.close();}
}
