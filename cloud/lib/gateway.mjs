// The portfolio Worker signs server-to-server requests after Sites authenticates
// the visitor. Browser-supplied identity/signature headers are never forwarded.
import { sha, b64, unb64 } from './security.mjs';
export const PREFIX='/plugin-archive';
async function key(secret,usage){if(!secret||unb64(secret).length!==32)throw new Error('gateway_unconfigured');return crypto.subtle.importKey('raw',unb64(secret),{name:'HMAC',hash:'SHA-256'},false,[usage]);}
export async function signEnvelope(secret,envelope){return b64(new Uint8Array(await crypto.subtle.sign('HMAC',await key(secret,'sign'),new TextEncoder().encode(envelope))));}

export async function verifyGateway(request, secret, origin) {
  let stage = "start";

  // 只记录失败阶段和非敏感诊断信息
  function reject(reason, details = {}) {
    console.warn("[gateway] verification rejected:", {
      stage,
      reason,
      ...details
    });
    return null;
  }

  try {
    stage = "read_headers";

    const raw = request.headers.get("x-aa-envelope") || "";
    const signature = request.headers.get("x-aa-signature") || "";

    if (raw.length > 8000 || signature.length > 100) {
      return reject("header_too_large");
    }

    stage = "verify_hmac";

    const gatewayKey = await key(secret, "verify");
    const signatureBytes = unb64(signature);

    const valid = await crypto.subtle.verify(
      "HMAC",
      gatewayKey,
      signatureBytes,
      new TextEncoder().encode(raw)
    );

    if (!valid) {
      return reject("hmac_mismatch");
    }

    stage = "parse_envelope";

    const e = JSON.parse(raw);
    const url = new URL(e.url);

    stage = "check_timestamp";

    const ageMs = Math.abs(Date.now() - e.at);

    if (ageMs > 30000) {
      return reject("timestamp_out_of_window", {
        ageMs: Number.isFinite(ageMs) ? ageMs : null
      });
    }

    stage = "check_origin";

    if (url.origin !== origin) {
      return reject("public_origin_mismatch", {
        originMatches: false
      });
    }

    stage = "check_path_prefix";

    if (!url.pathname.startsWith(PREFIX + "/")) {
      return reject("invalid_path_prefix");
    }

    stage = "check_method";

    if (e.method !== request.method) {
      return reject("method_mismatch");
    }

    const requestUrl = new URL(request.url);

    stage = "check_request_path";

    if (requestUrl.pathname !== url.pathname) {
      return reject("request_path_mismatch");
    }

    stage = "check_request_query";

    if (requestUrl.search !== url.search) {
      return reject("request_query_mismatch");
    }

    stage = "check_envelope_fields";

    if (
      typeof e.user !== "string" ||
      e.user.length > 500 ||
      typeof e.origin !== "string" ||
      e.origin.length > 500
    ) {
      return reject("invalid_envelope_fields");
    }

    stage = "check_body_hash";

    const actualHash = await sha(
      await request.clone().arrayBuffer()
    );

    if (e.hash !== actualHash) {
      return reject("body_hash_mismatch");
    }

    console.log("[gateway] verification passed");

    return e;

  } catch (error) {
    console.error("[gateway] verification error:", {
      stage,
      errorType: error?.name || "UnknownError"
    });

    return null;
  }
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
