const encoder = new TextEncoder();
export class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export function b64(bytes) { return btoa(String.fromCharCode(...bytes)); }
export function unb64(value) { return Uint8Array.from(atob(value), c => c.charCodeAt(0)); }
export async function sha(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', typeof value === 'string' ? encoder.encode(value) : value))].map(b=>b.toString(16).padStart(2,'0')).join('');
}
async function derive(master, label, algorithm, usage) {
  if (!master || unb64(master).length !== 32) throw new AppError('服务密钥尚未配置，请联系站点维护者。',503);
  const key = await crypto.subtle.importKey('raw',unb64(master),'HKDF',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:encoder.encode('audio-archive/v1'),info:encoder.encode(label)},key,algorithm,false,usage);
}
export async function ownerHash(master, userId) {
  const key=await derive(master,'identity',{name:'HMAC',hash:'SHA-256'},['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC',key,encoder.encode(userId)))].map(b=>b.toString(16).padStart(2,'0')).join('');
}
export async function seal(master, owner, data) {
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const key=await derive(master,'vault',{name:'AES-GCM',length:256},['encrypt']);
  const result=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encoder.encode(owner)},key,encoder.encode(JSON.stringify(data)));
  return 'v1.'+b64(iv)+'.'+b64(new Uint8Array(result));
}
export async function unseal(master, owner, text) {
  try {
    const [version,iv,cipher]=text.split('.');
    if(version!=='v1') throw new Error();
    const key=await derive(master,'vault',{name:'AES-GCM',length:256},['decrypt']);
    return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(iv),additionalData:encoder.encode(owner)},key,unb64(cipher))));
  } catch { throw new AppError('配置无法解密，请清除配置后重新填写。',409); }
}
export function verifyOrigin(request) {
  if(request.headers.get('origin')!==new URL(request.url).origin || request.headers.get('x-audio-archive')!=='1') throw new AppError('请求来源不匹配，请从本站页面操作。',403);
}
export async function jsonBody(request, maximum=12*1024*1024) {
  if(!request.headers.get('content-type')?.startsWith('application/json')) throw new AppError('请发送 JSON 请求。',415);
  if(Number(request.headers.get('content-length')||0)>maximum) throw new AppError('本批内容过大，请减少页面数量。',413);
  const reader=request.body?.getReader(); if(!reader) throw new AppError('缺少请求内容。');
  const chunks=[]; let size=0;
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>maximum){await reader.cancel();throw new AppError('本批内容过大。',413);}chunks.push(value);}
  const all=new Uint8Array(size);let at=0;for(const c of chunks){all.set(c,at);at+=c.length;}
  try{return JSON.parse(new TextDecoder().decode(all));}catch{throw new AppError('请求不是有效 JSON。');}
}
export const providers={
  openai:{name:'OpenAI',base:'https://api.openai.com/v1',console:'https://platform.openai.com/api-keys'},
  qwen:{name:'阿里云百炼（中国内地）',base:'https://dashscope.aliyuncs.com/compatible-mode/v1',console:'https://bailian.console.aliyun.com/'},
  siliconflow:{name:'硅基流动',base:'https://api.siliconflow.cn/v1',console:'https://cloud.siliconflow.cn/account/ak'},
};
export function resource(value,kind,optional=false) {
  value=String(value||'').trim();if(!value&&optional)return '';
  if(value.includes('://')){let u;try{u=new URL(value);}catch{throw new AppError('飞书链接格式错误。');}
    if(u.protocol!=='https:'||!/(^|\.)feishu\.cn$/.test(u.hostname)||u.username||u.password)throw new AppError('请输入飞书 HTTPS 链接。');
    if(kind==='table'){value=u.searchParams.get('table')||'';}else{const p=u.pathname.split('/');value=p[p.indexOf(kind)+1];if(!p.includes(kind))throw new AppError('链接中应包含 /'+kind+'/。');}}
  if(!/^[a-zA-Z0-9_-]{5,200}$/.test(value))throw new AppError('飞书资源标识格式错误：'+kind);return value;
}
export function cleanSettings(input,previous={}) {
  const allowed=new Set(['provider','model','apiKey','appId','appSecret','folder','summary','base','table']);
  if(!input || typeof input!=='object'||Object.keys(input).some(k=>!allowed.has(k)))throw new AppError('配置包含未知字段。');
  for(const [k,v]of Object.entries(input))if(typeof v!=='string'||v.length>2000)throw new AppError('配置项过长或格式不正确：'+k);
  const result={...previous,...input};
  if(previous.provider&&input.provider!==previous.provider&&!input.apiKey)throw new AppError('更换模型服务商时，请同时填写新服务商的 API Key。');
  for(const k of ['apiKey','appSecret'])if(!input[k])result[k]=previous[k]||'';
  if(!providers[result.provider])throw new AppError('请选择受支持的模型服务商。');
  if(!/^[\w./:@+-]{1,160}$/.test(result.model||''))throw new AppError('请填写有效模型 ID。');
  if(!/^cli_[a-zA-Z0-9]+$/.test(result.appId||''))throw new AppError('App ID 应以 cli_ 开头。');
  if(!result.appSecret||!result.apiKey)throw new AppError('首次保存需要 API Key 和 App Secret。');
  for(const [k,kind]of [['folder','folder'],['summary','docx'],['base','base'],['table','table']])result[k]=resource(result[k],kind,true);
  if(!!result.base!==!!result.table)throw new AppError('多维表格 App Token 和 Table ID 需同时填写或留空。');
  if(result.appId!==previous.appId||result.appSecret!==previous.appSecret)delete result.token;
  return result;
}
export function publicSettings(config={}) {
  const out={};for(const k of ['provider','model','appId','folder','summary','base','table'])out[k]=config[k]||'';
  return {...out,hasApiKey:!!config.apiKey,hasAppSecret:!!config.appSecret,authorized:!!config.token?.access_token,authorizationExpires:config.token?.expires_at||0};
}
