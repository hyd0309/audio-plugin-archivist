// The portfolio Worker signs server-to-server requests after Sites authenticates
// the visitor. Browser-supplied identity/signature headers are never forwarded.
import { sha, b64, unb64 } from './security.mjs';
export const PREFIX='/plugin-archive';
async function key(secret,usage){if(!secret||unb64(secret).length!==32)throw new Error('gateway_unconfigured');return crypto.subtle.importKey('raw',unb64(secret),{name:'HMAC',hash:'SHA-256'},false,[usage]);}
export async function signEnvelope(secret,envelope){return b64(new Uint8Array(await crypto.subtle.sign('HMAC',await key(secret,'sign'),new TextEncoder().encode(envelope))));}
export async function verifyGateway(request,secret,origin){
  try{
    const raw=request.headers.get('x-aa-envelope')||'',signature=request.headers.get('x-aa-signature')||'';
    if(raw.length>8000||signature.length>100)return null;
    if(!await crypto.subtle.verify('HMAC',await key(secret,'verify'),unb64(signature),new TextEncoder().encode(raw)))return null;
    const e=JSON.parse(raw),url=new URL(e.url);
    if(Math.abs(Date.now()-e.at)>30000||url.origin!==origin||!url.pathname.startsWith(PREFIX+'/')||e.method!==request.method||new URL(request.url).pathname!==url.pathname||new URL(request.url).search!==url.search)return null;
    if(typeof e.user!=='string'||e.user.length>500||typeof e.origin!=='string'||e.origin.length>500)return null;
    if(e.hash!==await sha(await request.clone().arrayBuffer()))return null;
    return e;
  }catch{return null;}
}
export async function forwardToApplication(request,env,fetcher=fetch){
  const url=new URL(request.url);if(!url.pathname.startsWith(PREFIX+'/'))return new Response('Not found',{status:404});
  if(Number(request.headers.get('content-length')||0)>12*1024*1024)return new Response('Request too large',{status:413});
  // Bound chunked requests too, before buffering/signing the body.
  const parts=[];let size=0;const reader=request.body?.getReader();
  if(reader)while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>12*1024*1024){await reader.cancel();return new Response('Request too large',{status:413});}parts.push(value);}
  const body=new Uint8Array(size);let pos=0;for(const part of parts){body.set(part,pos);pos+=part.length;}
  const envelope=JSON.stringify({at:Date.now(),url:url.href,method:request.method,hash:await sha(body),user:request.headers.get('oai-authenticated-user-id')||'',origin:request.headers.get('origin')||''});
  const headers=new Headers();
  for(const name of ['content-type','cookie','accept','rsc','next-router-state-tree','next-router-prefetch','x-audio-archive','origin','referer']){const value=request.headers.get(name);if(value)headers.set(name,value);}
  headers.set('x-aa-envelope',envelope);headers.set('x-aa-signature',await signEnvelope(env.GATEWAY_KEY,envelope));
  const target=new URL(url.pathname+url.search,env.AUDIO_APP_ORIGIN);
  try{return await fetcher(target,{method:request.method,headers,body:['GET','HEAD'].includes(request.method)?undefined:body,redirect:'manual'});}catch{return new Response('归档服务暂不可用，请稍后重试。',{status:502,headers:{'Content-Type':'text/plain;charset=utf-8','Cache-Control':'no-store'}});}
}
