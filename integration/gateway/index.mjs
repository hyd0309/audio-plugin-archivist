import { forwardToApplication,PREFIX } from './bridge.mjs';
import assets from './assets.generated.mjs';
export default {
  async fetch(request,env){
    const url=new URL(request.url);
    if(url.pathname===PREFIX)return Response.redirect(url.origin+PREFIX+'/'+url.search,308);
    if(url.pathname.startsWith(PREFIX+'/'))return forwardToApplication(request,env);
    if(!['GET','HEAD'].includes(request.method))return new Response('Method not allowed',{status:405});
    const pathname=url.pathname.endsWith('/')?url.pathname+'index.html':url.pathname;
    const asset=assets[pathname];if(!asset)return new Response('Not found',{status:404});
    const bytes=Uint8Array.from(atob(asset.data),c=>c.charCodeAt(0));
    return new Response(request.method==='HEAD'?null:bytes,{headers:{'Content-Type':asset.type,'Cache-Control':asset.type.startsWith('text/html')?'no-cache':'public, max-age=300','X-Content-Type-Options':'nosniff','ETag':'"'+asset.hash+'"'}});
  }
};
