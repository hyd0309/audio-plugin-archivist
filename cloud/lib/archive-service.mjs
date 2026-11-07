import { AppError, sha, resource } from './security.mjs';
import { FIELDS, plain, block, markdownBlocks, validateRecord } from './records.mjs';
import { detailParts } from './figures.mjs';

export async function provision(fs) {
  const c=fs.config;
  for(const key of ['summary','base','table']) {
    if(c[key])continue;
    if(c.provisioning)throw new AppError('上次创建 '+c.provisioning+' 的结果不确定，请先到飞书查找该资源并在配置中填入其标识。',409);
    c.provisioning=key;await fs.save(c);
    if(key==='summary')c.summary=(await fs.request('POST','/docx/v1/documents',{title:'效果器档案室 · 汇总',...(c.folder?{folder_token:c.folder}:{})})).document.document_id;
    if(key==='base')c.base=(await fs.request('POST','/bitable/v1/apps',{name:'效果器档案室',...(c.folder?{folder_token:c.folder}:{})})).app.app_token;
    if(key==='table')c.table=(await fs.request('POST',`/bitable/v1/apps/${c.base}/tables`,{table:{name:'插件档案',default_view_name:'全部插件',fields:FIELDS.map(([field_name,type])=>({field_name,type,...(type===5?{property:{date_formatter:'yyyy/MM/dd',auto_fill:false}}:{})}))}})).table_id;
    delete c.provisioning;await fs.save(c);
  }
  const root=`/bitable/v1/apps/${c.base}/tables/${c.table}`;
  let fields=await fs.all(root+'/fields',100);
  // Add only our missing technical recovery column to a compatible existing table.
  const missing=FIELDS.filter(([n,t])=>!fields.some(f=>f.field_name===n&&f.type===t));
  if(missing.some(([n])=>n!=='归档进度'))throw new AppError('已有数据表结构不匹配。请使用本应用新建的插件档案表，或按配置手册调整列类型。');
  if(missing.length){await fs.request('POST',root+'/fields',{field_name:'归档进度',type:1});fields=await fs.all(root+'/fields',100);}
  await fs.request('GET',`/docx/v1/documents/${c.summary}`);
  return {summaryUrl:`https://www.feishu.cn/docx/${c.summary}`,tableUrl:`https://www.feishu.cn/base/${c.base}?table=${c.table}`};
}
function tableRoot(c){if(!c.base||!c.table||!c.summary)throw new AppError('请先建立或填写飞书归档位置。',409);return `/bitable/v1/apps/${c.base}/tables/${c.table}`;}
function links(c,doc){return {detailUrl:doc?`https://www.feishu.cn/docx/${doc}`:'',summaryUrl:`https://www.feishu.cn/docx/${c.summary}`,tableUrl:`https://www.feishu.cn/base/${c.base}?table=${c.table}`};}
async function uuid(value){const h=await sha(value);return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;}
export async function syncArchive(fs,input) {
  if(!/^[a-f0-9]{64}$/.test(input.fingerprint||''))throw new AppError('PDF 指纹无效。');
  if(!Array.isArray(input.pages)||input.pages.length>80)throw new AppError('手册页数无效。');
  const r=validateRecord(input.record,input.pages),c=fs.config,root=tableRoot(c);
  const image=input.image||'';
  if(image&&(!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(image)||image.length>4000000))throw new AppError('界面图格式无效或超过 3 MB。');
  const parts = detailParts(r.详细说明);
  const figures = parts.filter(part => part.kind === 'figure');
  const uploads = input.figures ?? [];
  if (!Array.isArray(uploads) || uploads.length !== figures.length ||
      figures.some((part, index) => part.id !== uploads[index]?.id ||
        typeof uploads[index]?.image !== 'string' || uploads[index].image.length > 1000000 ||
        !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(uploads[index].image))) {
    throw new AppError('正文插图缺失、格式不符或过大，请重新裁剪。');
  }
  const detailVersion = await sha(JSON.stringify([r.详细说明, uploads]));
  const pid='plugin-'+(await sha(r.筛选标签.厂商.normalize('NFKC').toLowerCase()+'\n'+r.名称.normalize('NFKC').toLowerCase())).slice(0,32);
  const found=await fs.request('POST',root+'/records/search?page_size=100',{filter:{conjunction:'and',conditions:[{field_name:'插件ID',operator:'is',value:[pid]}]}});
  if(found.has_more||found.items?.length>1)throw new AppError('飞书存在多个同名插件记录，请先到飞书核对。');
  let row=found.items?.[0],journal={};
  if(row){try{journal=JSON.parse(plain(row.fields['归档进度'])||'{}');}catch{throw new AppError('飞书归档进度已被修改，请先核对。');}
    if(journal.complete)return {...links(c,journal.doc),existing:true};
    if(!journal.version)throw new AppError('已有插件记录来自其他归档流程，已保留原记录。请直接在飞书查看或编辑。',409);
    if(journal.source!==input.fingerprint)throw new AppError('该插件已有另一份手册正在归档，请先处理原记录。',409);
    if(journal.pending)throw new AppError('上次写入步骤“'+journal.pending+'”结果不确定，已停止自动重试。请在飞书的“归档进度”列核对，避免重复创建。',409);
    if ((journal.detailVersion && journal.detailVersion !== detailVersion) ||
        (!journal.detailVersion && figures.length && Object.keys(journal.done || {}).some(key => key.startsWith('详情正文-')))) {
      throw new AppError('已有未完成的详情与当前正文不同，请用原归档内容继续。',409);
    }
  }else{
    journal={version:1,source:input.fingerprint,detailVersion,done:{}};
    row=(await fs.request('POST',root+'/records?client_token='+await uuid(c.base+c.table+pid),{fields:{'名称':r.名称,'插件ID':pid,'源PDF指纹':input.fingerprint,'归档进度':JSON.stringify(journal)}})).record;
  }
  const save=()=>fs.request('PUT',root+'/records/'+row.record_id,{fields:{'归档进度':JSON.stringify(journal)}});
  const step=async(name,fn)=>{
    if(journal.done[name])return journal.done[name];
    journal.pending=name;await save();const value=await fn();journal.done[name]=value||true;delete journal.pending;await save();return value;
  };
  async function writeImage(target, data, label, key) {
    const bid = await step(label+'图片块',async()=> (await fs.append(target,[{block_type:27,image:{}}],await uuid(key))).children[0].block_id);
    const token = await step(label+'图片上传',()=>fs.upload(data,bid,'docx_image'));
    await step(label+'图片显示',async()=>{
      await fs.request('PATCH',`/docx/v1/documents/${target}/blocks/${bid}?document_revision_id=-1`,{replace_image:{token}});
      return true;
    });
  }
  const doc=await step('创建详情文档',async()=> (await fs.request('POST','/docx/v1/documents',{title:r.名称,...(c.folder?{folder_token:c.folder}:{})})).document.document_id);
  journal.doc=doc;journal.detailVersion=detailVersion;await save();
  let offset = 0;
  let figureIndex = 0;
  for (const part of parts) {
    if (part.kind === 'figure') {
      const key = pid+doc+'figure'+figureIndex;
      await writeImage(doc,uploads[figureIndex].image,'正文插图-'+figureIndex, key);
      await step('正文图注-'+figureIndex, async()=>{await fs.append(doc,[block(part.caption)],await uuid(key+'caption'));return true;});
      figureIndex++;
      offset++;
      continue;
    }
    const blocks = markdownBlocks(part.text);
    for (let start=0;start<blocks.length;start+=40) {
      const position=offset+start;
      await step('详情正文-'+position,async()=>{await fs.append(doc,blocks.slice(start,start+40),await uuid(pid+doc+'body'+position));return true;});
    }
    offset+=blocks.length;
  }
  const tableText = parts.map(part => part.kind === 'text' ? part.text : part.caption).join('\n');
  const fields={'名称':r.名称,'厂商':r.筛选标签.厂商,'类属':r.类属,'适用音源':r.筛选标签.适用音源,'风格场景':r.风格场景,'详细说明':tableText,'详情文档':{text:r.名称,link:links(c,doc).detailUrl},'最后同步时间':Date.now(),...(r.官网链接?{'官网链接':{text:'官网',link:r.官网链接}}:{})};
  if(image){const token=await step('表格界面图',()=>fs.upload(image,c.base,'bitable_image'));fields['界面图']=[{file_token:token}];}
  await step('表格字段',async()=>{await fs.request('PUT',root+'/records/'+row.record_id,{fields});return true;});
  await step('汇总字段',async()=>{await fs.append(c.summary,[block(r.名称,'heading2'),block('类属：'+r.类属.join(' / ')),block('风格场景：'+r.风格场景.join(' / ')),block('官网：'+(r.官网链接||'手册未说明'))],await uuid(pid+c.summary+'fields'));return true;});
  if(image)await writeImage(c.summary,image,'汇总',pid+c.summary+'image');
  await step('详情文档引用',async()=>{await fs.append(c.summary,[{block_type:2,text:{elements:[{mention_doc:{token:doc,obj_type:22,url:encodeURIComponent(links(c,doc).detailUrl),title:r.名称}}]}}],await uuid(pid+c.summary+'ref'));return true;});
  const detail=await fs.request('GET',`/docx/v1/documents/${doc}/raw_content`);
  const verified=(await fs.request('GET',root+'/records/'+row.record_id)).record;
  if(!detail.content?.includes('核心功能概述')||plain(verified.fields['名称'])!==r.名称)throw new AppError('写入已完成，但读回核验未通过，请打开飞书检查。',502);
  journal.complete=true;await save();return {...links(c,doc),existing:false};
}
export async function knowledge(fs,query) {
  const root=tableRoot(fs.config);const rows=await fs.all(root+'/records',2000);
  const terms=[...new Set((query.toLowerCase().match(/[a-z0-9]+|[\u4e00-\u9fff]+/g)||[]).flatMap(t=>/^[a-z0-9]/.test(t)?[t]:Array.from({length:Math.max(1,t.length-1)},(_,i)=>t.slice(i,i+2))))];
  const records=rows.map(row=>{const f=row.fields;const content=JSON.stringify(f);return {f,score:terms.reduce((n,t)=>n+(content.toLowerCase().includes(t)?1:0),0)};}).sort((a,b)=>b.score-a.score).slice(0,10);
  const docs=[];let budget=60000;
  for(const {f}of records){
    const link=f['详情文档']?.link;if(!link)continue;
    let id;try{id=resource(link,'docx');}catch{continue;}
    const full=await fs.request('GET',`/docx/v1/documents/${id}/raw_content`);
    const text=(full.content||'').slice(0,Math.min(12000,budget));budget-=text.length;
    docs.push({name:plain(f['名称']),categories:f['类属'],scenarios:f['风格场景'],sources:f['适用音源'],url:link,text});
    if(budget<=0)break;
  }
  return {docs,total:rows.length,selected:docs.length};
}
