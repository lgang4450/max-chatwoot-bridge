import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export function equalSecret(actual: unknown, expected: string) {
  return typeof actual === 'string' && !!expected && timingSafeEqual(Buffer.from(digest(actual),'hex'),Buffer.from(digest(expected),'hex'));
}
export function verifyChatwoot(body: Buffer, timestamp: unknown, signature: unknown, secret: string, now = Date.now()) {
  if (typeof timestamp !== 'string' || !/^\d{10}$/.test(timestamp) || Math.abs(now/1000-Number(timestamp))>300) return false;
  const expected = 'sha256=' + createHmac('sha256',secret).update(timestamp+'.').update(body).digest('hex');
  return equalSecret(signature, expected);
}
export function isPublicAddress(address: string) {
  // IPv6 and mapped addresses fail closed; use the public IPv4 result only.
  if (isIP(address) !== 4) return false;
  const [a,b] = address.split('.').map(Number);
  return !(a===0 || a===10 || a===127 || a>=224 || (a===100 && b>=64 && b<=127) || (a===169 && b===254) || (a===172 && b>=16 && b<=31) || (a===192 && [0,168].includes(b)) || (a===198 && [18,19,51].includes(b)) || (a===203 && b===0));
}
export function allowedMediaUrl(raw: string, policy: {origin?: string; hosts?: string[]}) {
  const url = new URL(raw);
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || isIP(host) || host==='localhost') throw new Error('Media URL rejected');
  if (policy.origin ? url.origin !== policy.origin : !policy.hosts?.some(x=>host===x || host.endsWith('.'+x))) throw new Error('Media host rejected');
  return url;
}
export function inbound(payload: any) {
  const m = payload?.message;
  if (payload?.update_type !== 'message_created' || !m || m.sender?.is_bot || m.recipient?.chat_type !== 'dialog') return null;
  const id = m.sender?.user_id, mid = m.body?.mid;
  if (!Number.isSafeInteger(id) || id<=0 || typeof mid !== 'string' || !mid || mid.length>256) throw new Error('Invalid MAX identity');
  return {id:String(id), mid, text: typeof m.body.text==='string' ? m.body.text : '', name:[m.sender.first_name,m.sender.last_name].filter(Boolean).join(' ') || 'MAX user', attachments:m.body.attachments || []};
}
export function outgoing(p: any, account: number, inbox: number) {
  return p?.event==='message_created' && ['outgoing','template'].includes(p.message_type) && p.private===false && Number(p.account?.id)===account && Number(p.inbox?.id ?? p.conversation?.inbox_id)===inbox && Number.isSafeInteger(p.id) && p.id>0 && Number.isSafeInteger(p.conversation?.id);
}
// Log only controlled labels/status; never serialize exception bodies, requests or payloads.
export function report(event: string, code = 0) { console.log(JSON.stringify({event,code})); }
