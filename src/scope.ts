import {digest} from './security.js';
import type {Config} from './config.js';
import type {Redis} from 'ioredis';
export const scopeOf=(c:Config)=>digest(JSON.stringify({instance:c.mediaOrigin,account:c.account,inbox:c.inbox,bot:c.maxBotId||'unconfigured'}));
export const keyOf=(c:Config,k:string)=>`mb:${scopeOf(c)}:${k}`;
export const queueName=(c:Config,d:string)=>`max-bridge-${scopeOf(c)}-${d}`;
export async function assertScope(c:Config,r:Redis) {
 const scope=scopeOf(c);await r.set('max-bridge:config',scope,'NX');
 if(await r.get('max-bridge:config')!==scope)throw Error('Configuration fingerprint mismatch; explicit empty-state rebind required');
}
