import { AppError } from './security.mjs';
const BASE='https://open.feishu.cn/open-apis';
export const SCOPES='docx:document drive:drive bitable:app offline_access';
export class Feishu {
  constructor(config,save,fetcher=fetch){this.config=config;this.save=save;this.fetcher=fetcher;}
  async exchange(extra){
    let response,result;
    try{response=await this.fetcher(BASE+'/authen/v2/oauth/token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_id:this.config.appId,client_secret:this.config.appSecret,...extra}),redirect:'error',signal:AbortSignal.timeout(25000)});result=await response.json();}catch{throw new AppError('授权连接中断，请重新授权。',502);}
    if(!response.ok||result.code||!result.access_token)throw new AppError('飞书授权失败，请核对权限、应用发布和回调地址。代码 '+(result.code||response.status),502);
    this.config.token={access_token:result.access_token,refresh_token:result.refresh_token,expires_at:Date.now()+result.expires_in*1000};
    await this.save(this.config);
  }
  async token(){
    const t=this.config.token;if(!t?.access_token)throw new AppError('请先完成飞书授权。',409);
    if(t.expires_at<Date.now()+90000){
      if(!t.refresh_token||t.uncertain)throw new AppError('飞书授权已过期，请重新授权。',409);
      t.uncertain=true;await this.save(this.config);
      await this.exchange({grant_type:'refresh_token',refresh_token:t.refresh_token});
    }
    return this.config.token.access_token;
  }
  async request(method,path,body){
    const token=await this.token();let response,result;
    try{response=await this.fetcher(BASE+path,{method,headers:{Authorization:'Bearer '+token,...(body instanceof FormData?{}:{'Content-Type':'application/json'})},body:body?body instanceof FormData?body:JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(25000)});result=await response.json();}catch{throw new AppError(method==='GET'?'无法读取飞书，请稍后再试。':'飞书写入结果不确定，请到飞书核对归档进度，避免重复操作。',502);}
    if(!response.ok||result.code)throw new AppError('飞书操作失败（'+(result.code||response.status)+'）。请检查用户身份权限、可用范围和文档编辑权。',502);
    return result.data||result;
  }
  async all(path,limit=2000){
    let result=[],token='';do{const page=await this.request('GET',path+(path.includes('?')?'&':'?')+'page_size=100'+(token?'&page_token='+encodeURIComponent(token):''));result.push(...(page.items||[]));if(result.length>limit)throw new AppError('飞书数据超过本次处理上限 '+limit+' 条，请拆分到单独数据表。');token=page.has_more?page.page_token:'';}while(token);return result;
  }
  append(doc,blocks,key){return this.request('POST',`/docx/v1/documents/${doc}/blocks/${doc}/children?document_revision_id=-1&client_token=${key}`,{children:blocks,index:-1});}
  async upload(image,parent,parentType){
    const bytes=Uint8Array.from(atob(image.split(',')[1]),c=>c.charCodeAt(0));
    const form=new FormData();form.set('file_name','interface.jpg');form.set('parent_type',parentType);form.set('parent_node',parent);form.set('size',String(bytes.length));form.set('file',new Blob([bytes],{type:'image/jpeg'}),'interface.jpg');
    return (await this.request('POST','/drive/v1/medias/upload_all',form)).file_token;
  }
}
