import { readFileSync } from 'node:fs';
export type Config = ReturnType<typeof loadConfig>;
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('TLS verification is required');
  const enabled = env.BRIDGE_ENABLED === 'true';
  const secret = (key: string) => env[`${key}_FILE`] ? readFileSync(env[`${key}_FILE`]!, 'utf8').trim() : (env[key] || '');
  const number = (key: string, fallback: number) => {
    const n = Number(env[key] || fallback);
    if (!Number.isSafeInteger(n) || n < 1) throw new Error(`Invalid ${key}`);
    return n;
  };
  const cfg = {
    enabled, port: number('PORT', 3000), redisUrl: secret('REDIS_URL') || 'redis://redis:6379',
    maxToken: secret('MAX_BOT_TOKEN'), maxSecret: secret('MAX_WEBHOOK_SECRET'),
    maxBotId: env.MAX_BOT_ID || '', cwSecret: secret('CHATWOOT_WEBHOOK_SECRET'),
    cwToken: secret('CHATWOOT_API_TOKEN'), cwUrl: env.CHATWOOT_BASE_URL || 'http://chatwoot:3000',
    account: number('CHATWOOT_ACCOUNT_ID', 1), inbox: number('CHATWOOT_INBOX_ID', 1),
    mediaOrigin: env.CHATWOOT_MEDIA_ORIGIN || 'https://support.example.com',
    maxMediaHosts: (env.MAX_MEDIA_HOSTS || 'max.ru,okcdn.ru,mycdn.me').split(',').map(x=>x.trim()).filter(Boolean),
    maxBytes: number('MAX_ATTACHMENT_BYTES', 10 * 1024 * 1024), maxQueue: number('MAX_QUEUE_DEPTH', 1000),
  };
  const cw = new URL(cfg.cwUrl), media = new URL(cfg.mediaOrigin);
  if (!['http:', 'https:'].includes(cw.protocol) || cw.username || cw.password || cw.search || cw.hash || cw.pathname !== '/') throw new Error('Invalid Chatwoot origin');
  if (media.protocol !== 'https:' || media.username || media.password || media.pathname !== '/') throw new Error('Invalid media origin');
  if (enabled && (!cfg.maxToken || !cfg.cwToken || cfg.maxSecret.length < 32 || cfg.cwSecret.length < 32 || !/^\d+$/.test(cfg.maxBotId))) throw new Error('Missing enabled bridge credentials/identity');
  return cfg;
}
