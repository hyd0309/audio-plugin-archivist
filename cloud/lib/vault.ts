import { env } from 'cloudflare:workers';
import { AppError, ownerHash, seal, unseal } from './security.mjs';
export function runtime() {
  const e=env as unknown as {DB:D1Database; VAULT_KEY:string};
  if(!e.DB||!e.VAULT_KEY)throw new AppError('服务配置尚未完成。',503);return e;
}
export async function ownerFor(request:Request) {
  const id=request.headers.get('oai-authenticated-user-id');
  if(!id||!request.headers.get('oai-authenticated-user-email'))throw new AppError('请先登录。',401);
  return ownerHash(runtime().VAULT_KEY,id);
}
export async function readVault(owner:string) {
  const e=runtime();const row=await e.DB.prepare('SELECT vault FROM accounts WHERE owner=?').bind(owner).first<{vault:string}>();
  return row?await unseal(e.VAULT_KEY,owner,row.vault):{};
}
export async function saveVault(owner:string,value:object) {
  const e=runtime();const encrypted=await seal(e.VAULT_KEY,owner,value);
  await e.DB.prepare('INSERT INTO accounts(owner,vault,updated) VALUES(?,?,?) ON CONFLICT(owner) DO UPDATE SET vault=excluded.vault,updated=excluded.updated').bind(owner,encrypted,Date.now()).run();
}
export async function guard<T>(owner:string,action:()=>Promise<T>,model=false):Promise<T> {
  const db=runtime().DB;const now=Date.now(),minute=Math.floor(now/60000),day=Math.floor(now/86400000),lease=crypto.randomUUID();
  await db.prepare('INSERT OR IGNORE INTO guards(owner) VALUES(?)').bind(owner).run();
  const locked=await db.prepare('UPDATE guards SET lease=?,until=?,minute=?,count=CASE WHEN minute=? THEN count+1 ELSE 1 END,day=?,calls=CASE WHEN day=? THEN calls+? ELSE ? END WHERE owner=? AND until<? AND (minute<>? OR count<60) AND (?=0 OR day<>? OR calls<120) RETURNING owner').bind(lease,now+1200000,minute,minute,day,day,model?1:0,model?1:0,owner,now,minute,model?1:0,day).first();
  if(!locked)throw new AppError('操作正在进行或达到频率上限，请稍后再试（每分钟 60 次、每天 120 次模型请求）。',429);
  try{return await action();}finally{await db.prepare('UPDATE guards SET until=0,lease=\'\' WHERE owner=? AND lease=?').bind(owner,lease).run();}
}
export async function forget(owner:string) {
  const db=runtime().DB;
  await db.batch([db.prepare('DELETE FROM accounts WHERE owner=?').bind(owner),db.prepare('DELETE FROM oauth WHERE owner=?').bind(owner)]);
}
