import { AppError, sha, jsonBody, verifyOrigin, cleanSettings, publicSettings } from '../../../lib/security.mjs';
import { ownerFor, readVault, saveVault, guard, forget, runtime } from '../../../lib/vault';
import { Feishu, SCOPES } from '../../../lib/feishu.mjs';
import { provision, syncArchive, knowledge } from '../../../lib/archive-service.mjs';
import { analyze, recommend } from '../../../lib/model.mjs';
import { APP_PATH } from '../../../lib/paths';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
function json(value:unknown,status=200){return Response.json(value,{status,headers});}
function cookie(request:Request,name:string){return request.headers.get('cookie')?.split(';').map(s=>s.trim()).find(s=>s.startsWith(name+'='))?.slice(name.length+1)||'';}
async function handle(request:Request) {
  const url=new URL(request.url),path=url.pathname.replace(APP_PATH,'').slice(5);
  if(path==='health'&&request.method==='GET')return json({ok:true,storage:'configuration-only'});
  try{
    const owner=await ownerFor(request);
    if(request.method!=='GET')verifyOrigin(request);
    if(path==='settings'&&request.method==='GET')return json(publicSettings(await readVault(owner)));
    const model=['analyze','recommend'].includes(path);
    return await guard(owner,async()=>{
      const c=await readVault(owner),save=(v:object)=>saveVault(owner,v),fs=new Feishu(c,save);
      if(path==='settings'&&request.method==='PUT'){
        const next=cleanSettings(await jsonBody(request,16000),c);
        if(next.provisioning&&next[next.provisioning])delete next.provisioning;
        await save(next);return json(publicSettings(next));
      }
      if(path==='settings'&&request.method==='DELETE'){await forget(owner);return json({cleared:true});}
      if(path==='feishu/authorize'&&request.method==='POST'){
        if(!c.appId||!c.appSecret)throw new AppError('请先保存飞书配置。');
        const state=crypto.randomUUID()+crypto.randomUUID(),browser=crypto.randomUUID();
        const db=runtime().DB;
        await db.batch([db.prepare('DELETE FROM oauth WHERE owner=? OR expires<?').bind(owner,Date.now()),db.prepare('INSERT INTO oauth(state,owner,binding,expires) VALUES(?,?,?,?)').bind(await sha(state),owner,await sha(browser+'\n'+c.appId),Date.now()+600000)]);
        const auth=new URL('https://accounts.feishu.cn/open-apis/authen/v1/authorize');
        auth.search=new URLSearchParams({client_id:c.appId,redirect_uri:url.origin+APP_PATH+'/api/feishu/callback',response_type:'code',scope:SCOPES,state}).toString();
        const response=json({url:auth.href});response.headers.set('Set-Cookie',`aa_oauth=${browser}; Path=${APP_PATH}/api/feishu; HttpOnly; SameSite=Lax; Max-Age=600${url.protocol==='https:'?'; Secure':''}`);return response;
      }
      if(path==='feishu/callback'&&request.method==='GET'){
        const state=url.searchParams.get('state')||'',code=url.searchParams.get('code')||'';
        if(!state||state.length>256||!code||code.length>2000)throw new AppError('授权被取消或授权码无效，请从配置页重试。');
        const browser=cookie(request,'aa_oauth');
        const consumed=await runtime().DB.prepare('DELETE FROM oauth WHERE state=? AND owner=? AND binding=? AND expires>? RETURNING state').bind(await sha(state),owner,await sha(browser+'\n'+c.appId),Date.now()).first();
        if(!browser||!consumed)throw new AppError('授权已过期、已使用或不是当前账号发起，请重新授权。',403);
        await fs.exchange({grant_type:'authorization_code',code,redirect_uri:url.origin+APP_PATH+'/api/feishu/callback'});
        return new Response(null,{status:303,headers:{...headers,Location:APP_PATH+'/?authorized=1#settings','Set-Cookie':`aa_oauth=; Path=${APP_PATH}/api/feishu; HttpOnly; SameSite=Lax; Max-Age=0`}});
      }
      if(request.method!=='POST')throw new AppError('接口不存在。',404);
      if(path==='provision')return json(await provision(fs));
      const body=await jsonBody(request);
      if(path==='analyze')return json(await analyze(c,body));
      if(path==='archive')return json(await syncArchive(fs,body));
      if(path==='recommend'){
        if(typeof body.query!=='string'||!body.query.trim()||body.query.length>3000)throw new AppError('请描述不超过 3000 字的选用需求。');
        const context=await knowledge(fs,body.query);
        return json({answer:await recommend(c,body.query,context),sources:context.docs.map((d:{name:string;url:string})=>({name:d.name,url:d.url})),total:context.total,selected:context.selected});
      }
      throw new AppError('接口不存在。',404);
    },model);
  }catch(error){return json({error:error instanceof AppError?error.message:'操作未完成，请稍后重试；若正在写入飞书，请先核对归档进度。'},error instanceof AppError?error.status:500);}
}
export const GET=handle;export const POST=handle;export const PUT=handle;export const DELETE=handle;
