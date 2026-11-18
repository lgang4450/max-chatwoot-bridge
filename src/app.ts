import express from 'express';
import type { Config } from './config.js';
import { equalSecret,verifyChatwoot,inbound,outgoing,digest } from './security.js';
export function createApp(cfg:Config,enqueue:(direction:'in'|'out',id:string,payload:any)=>Promise<void>,health:()=>Promise<unknown>) {
  const app=express();app.disable('x-powered-by');
  app.get('/health',async(_req,res)=>{try {res.json({mode:cfg.enabled?'active':'prepared',dependencies:await health()});}catch {res.status(503).json({status:'unavailable'});}});
  app.get('/ready',(_req,res)=>res.status(cfg.enabled?200:503).json({enabled:cfg.enabled}));
  app.use(express.raw({type:'application/json',limit:'64kb',inflate:false}));
  for(const path of ['/max-webhook','/chatwoot-webhook']) app.post(path,async(req,res)=>{
    if(!cfg.enabled) {res.sendStatus(503);return;}
    const max=path==='/max-webhook';
    const valid=max?equalSecret(req.headers['x-max-bot-api-secret'],cfg.maxSecret):verifyChatwoot(req.body,req.headers['x-chatwoot-timestamp'],req.headers['x-chatwoot-signature'],cfg.cwSecret);
    if(!valid) {res.sendStatus(401);return;}
    let payload:any;try {payload=JSON.parse(req.body.toString());}catch {res.sendStatus(400);return;}
    try {
      if(max) {const m=inbound(payload);if(m) await enqueue('in',digest(`${cfg.maxBotId}:${m.mid}`),payload);}
      else if(outgoing(payload,cfg.account,cfg.inbox)) await enqueue('out',String(payload.id),payload);
      res.sendStatus(200);
    } catch {res.sendStatus(503);}
  });
  app.use((_error:any,_req:any,res:any,_next:any)=>res.sendStatus(400));
  return app;
}
