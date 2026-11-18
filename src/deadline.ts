import {AsyncLocalStorage} from 'node:async_hooks';
const context=new AsyncLocalStorage<AbortSignal>();
export const withDeadline=<T>(signal:AbortSignal,run:()=>Promise<T>)=>context.run(signal,run);
export const requestSignal=(ms:number)=>{const current=context.getStore();return current?AbortSignal.any([current,AbortSignal.timeout(ms)]):AbortSignal.timeout(ms);};
