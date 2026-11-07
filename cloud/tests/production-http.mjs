// Run explicitly against the locally built Worker; no external API calls.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {sha} from '../lib/security.mjs';
import {signEnvelope} from '../lib/gateway.mjs';
const secret=Object.fromEntries(fs.readFileSync('.dev.vars','utf8').trim().split(/\r?\n/).map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1)]));
const origin='http://127.0.0.1:5176',target='http://127.0.0.1:5177',prefix='/plugin-archive';
async function request(user,path,method='GET',data,requestOrigin=origin){
  const body=data?JSON.stringify(data):undefined;
  const raw=JSON.stringify({at:Date.now(),url:origin+prefix+path,method,hash:await sha(body||''),user,origin:requestOrigin});
  return fetch(target+prefix+path,{method,headers:{'x-aa-envelope':raw,'x-aa-signature':await signEnvelope(secret.GATEWAY_KEY,raw),'Origin':requestOrigin,'Content-Type':'application/json','X-Audio-Archive':'1'},body,redirect:'manual'});
}
const alice='isolated-test-alice-'+Date.now(),bob='isolated-test-bob-'+Date.now();
assert.equal((await fetch(target+prefix+'/api/settings',{headers:{'oai-authenticated-user-id':alice,'oai-authenticated-user-email':'fake@example.test'}})).status,403);
assert.equal((await request('','/api/settings')).status,401);
assert.equal((await request('','/api/provision','POST',{})).status,401);
assert.equal((await request(alice,'/api/settings','PUT',{},'https://evil.test')).status,403);
const settings={provider:'qwen',model:'test-vl',apiKey:'fake-test-key',appId:'cli_test',appSecret:'fake-test-secret',folder:'',summary:'',base:'',table:''};
const saved=await request(alice,'/api/settings','PUT',settings);assert.equal(saved.status,200,await saved.clone().text());
const text=await saved.text();assert(!text.includes('fake-test-key'));assert(!text.includes('fake-test-secret'));
assert.equal((await (await request(alice,'/api/settings')).json()).hasApiKey,true);
assert.equal((await (await request(bob,'/api/settings')).json()).hasApiKey,false);
assert.equal((await request(alice,'/api/archives')).status,404);
assert.equal((await request(alice,'/api/feishu/callback?code=fake&state=wrong')).status,403);
const html=await (await request(alice,'/')).text();assert(html.includes('效果器工作台'));assert(!html.includes('示例合唱效果器'));
assert.equal((await request(alice,'/api/settings','DELETE')).status,200);
assert.equal((await (await request(alice,'/api/settings')).json()).hasApiKey,false);
console.log('Production Worker HTTP checks passed: anonymous denial, spoofed-header rejection, same-origin, two-user isolation, redaction, no archives API, OAuth mismatch, signed-in HTML and configuration deletion.');
