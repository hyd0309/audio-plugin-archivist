// Local-only integration preview. Not imported by either production Worker.
import http from 'node:http';
import fs from 'node:fs';
import {forwardToApplication} from '../lib/gateway.mjs';
const vars=Object.fromEntries(fs.readFileSync('.dev.vars','utf8').trim().split(/\r?\n/).map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1)]));
const env={...vars,AUDIO_APP_ORIGIN:'http://127.0.0.1:5177'};
http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://127.0.0.1:5176');
    if(url.pathname==='/signin-with-chatgpt'){res.writeHead(302,{'Set-Cookie':'preview_user=alice; Path=/; HttpOnly; SameSite=Lax',Location:'/ai/audio-archive/'});res.end();return;}
    if(url.pathname==='/signout-with-chatgpt'){res.writeHead(302,{'Set-Cookie':'preview_user=; Path=/; Max-Age=0',Location:'/ai/audio-archive/'});res.end();return;}
    const headers=new Headers();for(const [k,v] of Object.entries(req.headers)){if(k.startsWith('oai-')||k.startsWith('x-aa-'))continue;if(v)headers.set(k,String(v));}
    if(/(?:^|; )preview_user=alice(?:;|$)/.test(req.headers.cookie||''))headers.set('oai-authenticated-user-id','preview-alice');
    const request=new Request(url,{method:req.method,headers,body:['GET','HEAD'].includes(req.method)?undefined:req,duplex:'half'});
    const response=await forwardToApplication(request,env);const outputHeaders=new Headers(response.headers);outputHeaders.delete('content-encoding');outputHeaders.delete('content-length');res.writeHead(response.status,Object.fromEntries(outputHeaders));res.end(Buffer.from(await response.arrayBuffer()));
  }catch{res.writeHead(500);res.end('preview failed');}
}).listen(5176,'127.0.0.1',()=>console.log('Gateway preview http://127.0.0.1:5176/ai/audio-archive/'));
