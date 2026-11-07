import handler from "vinext/server/fetch-handler";
import { runWithConnectorBinding } from "../lib/connector-context";
import type { ConnectorBinding } from "../lib/connector-contract.mjs";
import { verifyGateway } from '../lib/gateway.mjs';

const worker = {
  async fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext<{ CONNECTORS?: ConnectorBinding }>) {
    if (!import.meta.env.DEV) {
      const runtime = env as unknown as { GATEWAY_KEY:string; PUBLIC_ORIGIN:string };
      const signed = await verifyGateway(request,runtime.GATEWAY_KEY,runtime.PUBLIC_ORIGIN);
      if (!signed) return new Response('请从个人网站的效果器档案室入口访问。',{status:403,headers:{'Cache-Control':'no-store','Content-Type':'text/plain;charset=utf-8'}});
      const headers = new Headers(request.headers);
      for(const name of [...headers.keys()]) if(name.startsWith('oai-authenticated-user-')||name.startsWith('x-aa-'))headers.delete(name);
      if(signed.user){headers.set('oai-authenticated-user-id','portfolio:'+signed.user);headers.set('oai-authenticated-user-email','unused@identity.invalid');}
      if(signed.origin)headers.set('origin',signed.origin);else headers.delete('origin');
      request = new Request(signed.url,{method:request.method,headers,body:request.body,redirect:'manual'});
    }
    let binding = ctx.props?.CONNECTORS;
    // Local preview emulates the same request-scoped capability. This branch and
    // the auxiliary service binding are absent from production builds.
    if (import.meta.env.DEV && !binding && env.CONNECTORS) {
      const preview = env.CONNECTORS;
      const expiresAt = Date.now() + 60_000;
      binding = {
        async getContext() {
          if (Date.now() >= expiresAt) return { status: "request_context_expired" };
          return preview.getContext?.() ?? { status: "binding_unavailable" };
        },
        async invoke(connectorId, actionName, args) {
          if (Date.now() >= expiresAt) {
            return { status: "request_context_expired", message: "This request has expired. Please try again." };
          }
          return preview.invoke(connectorId, actionName, args);
        },
      };
    }
    const response=await runWithConnectorBinding(binding, () => handler.fetch(request, env, ctx));
    const secured=new Response(response.body,response);
    secured.headers.set('Cache-Control','no-store');
    secured.headers.set('X-Content-Type-Options','nosniff');
    secured.headers.set('Referrer-Policy','no-referrer');
    secured.headers.set('X-Frame-Options','DENY');
    secured.headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; worker-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    return secured;
  },
};

export default worker;
