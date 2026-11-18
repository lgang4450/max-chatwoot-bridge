import { lookup } from 'node:dns/promises';
import { Agent, fetch, FormData } from 'undici';
import { allowedMediaUrl, isPublicAddress } from './security.js';
export class HttpFailure extends Error { constructor(public status=0) { super('Transport failure'); } }
export async function api(url: string, method='GET', body?: unknown, headers: Record<string,string>={}) {
  const form = body instanceof FormData;
  const response = await fetch(url,{method,headers:{...(!form && body!==undefined?{'Content-Type':'application/json'}:{}),...headers},body:body===undefined?undefined:form?body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(15000)});
  if (!response.ok) { await response.body?.cancel(); throw new HttpFailure(response.status); }
  const text = await response.text();
  if (text.length>4*1024*1024) throw new HttpFailure();
  return text ? JSON.parse(text) : {};
}
export async function download(raw: string, policy: {origin?:string;hosts?:string[]}, maxBytes: number): Promise<{data:Buffer;type:string}> {
  let url=allowedMediaUrl(raw,policy);
  for(let redirects=0; redirects<=3; redirects++) {
    const addresses=await lookup(url.hostname,{all:true,family:4});
    if(!addresses.length || addresses.some(a=>!isPublicAddress(a.address))) throw new HttpFailure();
    const pinned=addresses[0];
    const agent=new Agent({connect:{lookup:((_h:any,_o:any,cb:any)=>_o.all?cb(null,[pinned]):cb(null,pinned.address,4)) as any}});
    try {
      const response=await fetch(url,{dispatcher:agent,redirect:'manual',signal:AbortSignal.timeout(20000)});
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
    const response=await fetch(target,{redirect:'manual',headers:{'X-Forwarded-Host':new URL(publicOrigin).host,'X-Forwarded-Proto':'https'},signal:AbortSignal.timeout(20000)});
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
