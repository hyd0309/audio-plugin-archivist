import test from 'node:test';
import assert from 'node:assert/strict';
import { b64,ownerHash,seal,unseal,sha,verifyOrigin,jsonBody,cleanSettings,publicSettings,resource } from '../lib/security.mjs';
import { signEnvelope,verifyGateway,forwardToApplication } from '../lib/gateway.mjs';
const key=b64(crypto.getRandomValues(new Uint8Array(32)));
test('owner identity is keyed, stable and different per user',async()=>{
  const a=await ownerHash(key,'alice'),b=await ownerHash(key,'bob');assert.notEqual(a,b);assert.equal(a,await ownerHash(key,'alice'));assert.equal(a.length,64);assert.notEqual(a,await sha('alice'));
});
test('vault ciphertext binds owner and rejects tampering',async()=>{
  const secret={apiKey:'not-a-real-secret',token:{access_token:'fake'}};const a=await seal(key,'alice',secret),b=await seal(key,'alice',secret);
  assert.notEqual(a,b);assert(!a.includes(secret.apiKey));assert.deepEqual(await unseal(key,'alice',a),secret);await assert.rejects(unseal(key,'bob',a));await assert.rejects(unseal(key,'alice',a.slice(0,-6)+'AAAAAA'));
});
test('settings omit secrets and reject untrusted endpoints and cross-provider key reuse',()=>{
  const s={provider:'qwen',model:'test-vl',apiKey:'fake',appId:'cli_test',appSecret:'fake',folder:'',summary:'',base:'',table:''};
  assert.equal(cleanSettings({...s,apiKey:''},s).apiKey,'fake');assert.throws(()=>cleanSettings({...s,provider:'openai',apiKey:''},s));assert.throws(()=>cleanSettings({...s,baseUrl:'https://localhost'}));assert(!('apiKey'in publicSettings(s)));assert(!('appSecret'in publicSettings(s)));assert.throws(()=>resource('https://evil.example/docx/abcdef','docx'));assert.equal(resource('https://tenant.feishu.cn/docx/abcdef','docx'),'abcdef');
});
test('CSRF and size boundary reject before side effects',async()=>{
  const good={method:'POST',headers:{Origin:'https://app.test','X-Audio-Archive':'1','Content-Type':'application/json'},body:'{}'};
  verifyOrigin(new Request('https://app.test/api',good));assert.throws(()=>verifyOrigin(new Request('https://app.test/api',{...good,headers:{...good.headers,Origin:'https://evil.test'}})));
  await assert.rejects(jsonBody(new Request('https://app.test/api',{...good,body:'0123456789'}),5));assert.deepEqual(await jsonBody(new Request('https://app.test/api',good)),{});
});
test('gateway signature binds identity, origin, body, method and time',async()=>{
  const body='{"x":1}',path='/ai/audio-archive/api/settings';const env={at:Date.now(),url:'https://portfolio.test'+path,method:'POST',hash:await sha(body),user:'alice',origin:'https://portfolio.test'};
  const raw=JSON.stringify(env),signature=await signEnvelope(key,raw);const request=(b=body,rawValue=raw)=>new Request('https://service.test'+path,{method:'POST',headers:{'x-aa-envelope':rawValue,'x-aa-signature':signature},body:b});
  assert.equal((await verifyGateway(request(),key,'https://portfolio.test')).user,'alice');assert.equal(await verifyGateway(request('tampered'),key,'https://portfolio.test'),null);assert.equal(await verifyGateway(request(body,raw.replace('alice','bob')),key,'https://portfolio.test'),null);assert.equal(await verifyGateway(request(),key,'https://evil.test'),null);
  const stale=JSON.stringify({...env,at:Date.now()-60000});assert.equal(await verifyGateway(new Request('https://service.test'+path,{method:'POST',headers:{'x-aa-envelope':stale,'x-aa-signature':await signEnvelope(key,stale)},body}),key,'https://portfolio.test'),null);
});
test('gateway strips client identity/signature headers and forwards only signed platform identity',async()=>{
  const r=new Request('https://portfolio.test/ai/audio-archive/api/settings',{headers:{'oai-authenticated-user-id':'real-platform-user','x-aa-envelope':'fake','x-aa-signature':'fake','x-other-secret':'do-not-forward'}});
  const response=await forwardToApplication(r,{GATEWAY_KEY:key,AUDIO_APP_ORIGIN:'https://service.test'},async(url,opts)=>{assert.equal(opts.headers.get('x-other-secret'),null);assert.equal(opts.headers.get('oai-authenticated-user-id'),null);const verified=await verifyGateway(new Request(url,opts),key,'https://portfolio.test');assert.equal(verified.user,'real-platform-user');return new Response('ok');});assert.equal(await response.text(),'ok');
});
