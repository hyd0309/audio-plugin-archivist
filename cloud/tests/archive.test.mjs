import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRecord,markdownBlocks } from '../lib/records.mjs';
import { Feishu } from '../lib/feishu.mjs';
import { syncArchive,provision } from '../lib/archive-service.mjs';
import { complete } from '../lib/model.mjs';
const record={'名称':'Example Chorus（Stereo 手册）','类属':['合唱'],'风格场景':['流动感'],'详细说明':'## 核心功能概述\n合唱效果。\n## 界面控件说明\nDepth 调整深度。\n## 操作实践指南\n调整到所需深度。','官网链接':'','界面图':null,'筛选标签':{'厂商':'Example','适用音源':[],'音源依据':[]}};
test('record enforces original headings, name cleanup and optional evidenced sources',()=>{
  assert.equal(validateRecord(record,[]).名称,'Example Chorus');assert.throws(()=>validateRecord({...record,详细说明:'## 新格式\n'.repeat(10)},[]));
  assert.throws(()=>validateRecord({...record,'筛选标签':{...record.筛选标签,适用音源:['人声']}},[]));
  const r={...record,'筛选标签':{...record.筛选标签,适用音源:['人声'],音源依据:[{source:'人声',page:1,quote:'Recommended for vocals.'}]}};
  assert.deepEqual(validateRecord(r,[{number:1,text:'Recommended for vocals.'}]).筛选标签.适用音源,['人声']);
  assert.throws(()=>validateRecord({...record,官网链接:'https://invented.example'},[]));assert(markdownBlocks(record.详细说明).some(b=>b.block_type===4));
});
test('refresh token marked uncertain before rotating; no blind retry on network failure',async()=>{
  const saved=[];const c={appId:'cli_test',appSecret:'fake',token:{access_token:'old',refresh_token:'refresh',expires_at:0}};
  let calls=0;const fs=new Feishu(c,async v=>saved.push(structuredClone(v)),async()=>{calls++;throw new Error('network fake');});
  await assert.rejects(fs.token());assert.equal(saved[0].token.uncertain,true);await assert.rejects(fs.token());assert.equal(calls,1);
});
test('provider errors do not disclose returned credentials or upstream request bodies',async()=>{
  await assert.rejects(complete({provider:'qwen',model:'test',apiKey:'SECRET'},[],true,async()=>Response.json({error:'SECRET'},{status:401})),e=>!e.message.includes('SECRET')&&e.message.includes('401'));
});
function fakeFs(failStep=''){
  let row=null,created=0,summary='',detail='';const c={base:'baseToken',table:'tableToken',summary:'summaryToken'};
  return {config:c,save:async()=>{},get count(){return created},get row(){return row},all:async()=>[],
    async request(method,path,body){
      if(path.includes('/records/search?'))return {items:row?[structuredClone(row)]:[]};
      if(method==='POST'&&path.includes('/records?')){row={record_id:'recTest',fields:structuredClone(body.fields)};return {record:row};}
      if(method==='PUT'&&path.endsWith('/records/recTest')){Object.assign(row.fields,structuredClone(body.fields));return {record:row};}
      if(method==='POST'&&path==='/docx/v1/documents'){created++;if(failStep==='create')throw new Error('uncertain');return {document:{document_id:'docToken'}};}
      if(path.endsWith('/raw_content'))return {content:detail};
      if(method==='GET'&&path.endsWith('/records/recTest'))return {record:row};
      throw new Error('Unexpected '+method+' '+path);
    },async append(doc,blocks){const t=JSON.stringify(blocks);if(doc==='docToken')detail+=t;else summary+=t;return {children:[]};}
  };
}
test('archive completes in Feishu and repeat returns existing without duplicate docs',async()=>{
  const fs=fakeFs(),input={record,pages:[],fingerprint:'a'.repeat(64)};const first=await syncArchive(fs,input);assert.equal(first.existing,false);assert.equal(fs.count,1);assert.equal(JSON.parse(fs.row.fields.归档进度).complete,true);assert(!('evidence'in fs.row.fields));assert.equal((await syncArchive(fs,input)).existing,true);assert.equal(fs.count,1);
});
test('ambiguous cloud create is stopped on retry and progress lives only in Feishu',async()=>{
  const fs=fakeFs('create'),input={record,pages:[],fingerprint:'a'.repeat(64)};await assert.rejects(syncArchive(fs,input));await assert.rejects(syncArchive(fs,input),/结果不确定/);assert.equal(fs.count,1);
});
test('uncertain provisioning cannot create a second resource',async()=>{
  const fs={config:{provisioning:'summary'},save:async()=>{},request:async()=>{throw new Error('must not call');}};await assert.rejects(provision(fs),/不确定/);
});
