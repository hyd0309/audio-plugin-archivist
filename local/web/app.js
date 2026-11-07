'use strict';
const $=s=>document.querySelector(s);
const $$=s=>Array.from(document.querySelectorAll(s));
let items=[],settings={},category='',detailId='',history=[],lastDetailStamp='';
let toastTimer;
const statuses={queued:'等待处理',extracting:'读取手册',analyzing:'视觉理解中',awaiting_model:'等待分析结果',archived:'已归档',failed:'处理未完成',interrupted:'上次处理中断'};
function el(tag,text,cls){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(cls)node.className=cls;return node;}
function toast(message,error=false){const box=$('#toast');box.textContent=message;box.classList.toggle('error',error);box.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>box.hidden=true,error?10000:5000);}
async function api(path,{method='GET',body}={}){const headers={'X-Archive-Request':'1'};if(body&&!(body instanceof FormData)){headers['Content-Type']='application/json';body=JSON.stringify(body);}const response=await fetch('/api'+path,{method,headers,body});let data;try{data=await response.json();}catch{throw Error('服务响应异常，请检查本地程序是否仍在运行');}if(!response.ok)throw Error(typeof data.detail==='string'?data.detail:'请求内容不符合要求，请检查后重试');return data;}
async function guarded(fn,button){if(button)button.disabled=true;try{return await fn();}catch(error){toast(error.message,true);}finally{if(button)button.disabled=false;}}
function fileUrl(id,path){return '/api/archives/'+id+'/files/'+path;}
function link(text,href,cls){const a=el('a',text,cls);a.href=href;return a;}
function external(text,href){const a=link(text,href);a.target='_blank';a.rel='noopener noreferrer';return a;}
function safeMarkdown(text){const root=el('div',undefined,'description');let list;for(const line of text.split('\n')){const heading=line.match(/^(#{1,3})\s+(.+)/);if(heading){list=null;root.append(el('h'+Math.min(heading[1].length+1,4),heading[2]));}else if(line.startsWith('- ')){if(!list){list=el('ul');root.append(list);}list.append(el('li',line.slice(2)));}else{list=null;if(line.trim())root.append(el('p',line));}}return root;}
function route(){const path=location.hash.slice(1)||'library';const [view,id]=path.split('/');detailId=view==='archive'?id:'';const selected=view==='archive'?'detail':(['library','assistant','settings'].includes(view)?view:'library');$$('.view').forEach(n=>n.hidden=n.id!==selected+'-view');$$('[data-nav]').forEach(n=>n.classList.toggle('active',n.dataset.nav===(selected==='detail'?'library':selected)));$('#breadcrumb').textContent='工作台 / '+({library:'插件档案',assistant:'选用助手',settings:'连接与设置',detail:'插件详情'}[selected]);if(detailId){lastDetailStamp='';guarded(()=>loadDetail(detailId));}if(selected==='settings')guarded(loadSettings);}
async function loadSettings(){settings=await api('/settings');$('#bitable-status').textContent=(settings.bitable_authorized?'多维表格已授权。':'尚未授权多维表格。')+(settings.bitable_table_id?'插件表格已配置。':'点击创建以建立插件主表和视图。');$('#open-bitable').hidden=!settings.bitable_url;if(settings.bitable_url)$('#open-bitable').href=settings.bitable_url;const form=$('#settings-form');for(const [name,value]of Object.entries(settings)){const field=form.elements.namedItem(name);if(!field)continue;if(field.type==='checkbox')field.checked=Boolean(value);else field.value=value;}form.elements.llm_api_key.value='';form.elements.feishu_app_secret.value='';form.elements.llm_api_key.placeholder=settings.has_llm_api_key?'已保存；留空保留':'可选，本机模型通常不需要';form.elements.feishu_app_secret.placeholder=settings.has_feishu_app_secret?'已保存；留空保留':'填写自建应用密钥';$('#connection-status').textContent=settings.model_ready?'视觉模型已配置':'无 API · 对话辅助模式';$('#chat-mode-note').textContent=settings.model_ready?'模型会根据检索到的档案提供建议，并附上来源。':'当前使用本地关键词检索。复杂选用问题可在当前对话中继续讨论。';$('#feishu-status').textContent=settings.feishu_authorized?'已保存用户授权；同步前请检查连接。':'尚未完成用户授权。先保存应用配置，再点击“用飞书账号授权”。';}
function renderCloudPreview(root, sample, rows) {
  const record = sample?.record;
  const sync = sample?.sync;
  root.replaceChildren();
  root.append(el('h2', '飞书归档示意'), el('p', '用本地档案展示文档和表格的结构。', 'subtitle'));
  const grid = el('div', undefined, 'cloud-grid');
  const doc = el('article', undefined, 'cloud-card');
  doc.append(el('h3', '▤ 飞书文档'), el('p', '汇总条目 → 独立详细说明', 'cloud-kicker'));
  const page = el('div', undefined, 'cloud-paper');
  page.append(el('strong', record?.['名称'] || '插件名称'));
  if (record?.['界面图']) {
    const cover = el('img');
    cover.src = '/api/archives/' + sample.id + '/cover';
    cover.alt = record['名称'] + ' 界面图';
    page.append(cover);
  }
  page.append(el('p', record?.['类属'].join(' · ') || '类属 · 风格场景 · 官网'));
  const detail = el('div', undefined, 'cloud-reference');
  detail.append(el('b', '详细说明'), el('small', '核心功能概述 / 界面控件说明 / 操作实践指南'));
  page.append(detail);
  doc.append(page);
  const docLinks = el('div', undefined, 'cloud-links');
  if (sync?.summary_url) docLinks.append(external('打开汇总文档 ↗', sync.summary_url));
  if (sync?.detail_url) docLinks.append(external('打开详细说明 ↗', sync.detail_url));
  doc.append(docLinks);
  const base = el('article', undefined, 'cloud-card');
  base.append(el('h3', '▦ 飞书多维表格'), el('p', '一行一个插件 · 按类属和风格场景筛选', 'cloud-kicker'));
  const table = el('table', undefined, 'cloud-table');
  const head = table.createTHead().insertRow();
  for (const label of ['名称', '类属', '风格场景']) head.append(el('th', label));
  const body = table.createTBody();
  for (const item of rows.length ? rows : [{record:{'名称':'插件名称','类属':[],'风格场景':[]}}]) {
    const row = body.insertRow();
    const title = row.insertCell();
    const recordUrl = item.sync?.bitable?.url;
    if (recordUrl) title.append(external(item.record['名称'], recordUrl));
    else title.textContent = item.record['名称'];
    row.insertCell().textContent = item.record['类属'].join(' · ') || '—';
    row.insertCell().textContent = item.record['风格场景'].slice(0, 2).join(' · ') || '—';
  }
  const tableWrap = el('div', undefined, 'cloud-table-wrap');
  tableWrap.append(table);
  base.append(tableWrap);
  if (settings.bitable_url) base.append(external('打开多维表格 ↗', settings.bitable_url, 'cloud-open'));
  grid.append(doc, base);
  root.append(grid);
}

async function refresh(){
  items=await api('/archives');
  renderLibrary();
  const archived=items.filter(item=>item.record);
  renderCloudPreview($('#cloud-overview'), archived.find(item=>item.sync?.detail_url) || archived[0], archived.slice(0,3));
  if(detailId&&!$('#edit-dialog').open){
    const current=items.find(n=>n.id===detailId);
    if(current&&current.updated_at!==lastDetailStamp)await loadDetail(detailId);
  }
}
function renderLibrary(){const count=items.filter(n=>n.record).length;$('#archive-total').textContent=String(count).padStart(2,'0');$('#nav-count').textContent=count;$('#list-count').textContent=items.length+' 份手册';const categories=[...new Set(items.flatMap(n=>n.record?.['类属']||[]))];if(category&&!categories.includes(category))category='';const filters=$('#filters');filters.replaceChildren();for(const cat of ['',...categories]){const button=el('button',cat||'全部',cat===category?'active':'');button.dataset.category=cat;button.onclick=()=>{category=cat;renderLibrary();};filters.append(button);}const query=$('#search').value.trim().toLowerCase();const filtered=items.filter(n=>(!category||n.record?.['类属'].includes(category))&&(!query||JSON.stringify(n.record||n.filename).toLowerCase().includes(query)));const grid=$('#archive-grid');grid.replaceChildren();$('#empty-library').hidden=filtered.length>0;if(items.length&&!filtered.length){$('#empty-library h3').textContent='没有找到匹配的档案。';$('#empty-library p').textContent='试试其他名称、类别或场景关键词。';}else{$('#empty-library h3').textContent='你的第一份插件档案，从一本手册开始。';$('#empty-library p').textContent='界面图、名称、类属、风格场景、官网和详细说明，集中收藏。';}for(const item of filtered){const r=item.record;const card=link('', '#archive/'+item.id,'plugin-card');const visual=el('div',undefined,'plugin-image');if(r?.['界面图']){const img=el('img');img.src='/api/archives/'+item.id+'/cover';img.alt=r['名称']+' 插件界面';img.loading='lazy';visual.append(img);}else visual.append(el('span','≋','plugin-placeholder'));const info=el('div',undefined,'plugin-info');info.append(el('h3',r?.['名称']||item.filename));const tags=el('div',undefined,'tags');for(const tag of (r?.['类属']||['PDF 手册']).slice(0,3))tags.append(el('span',tag,'tag'));info.append(tags,el('p',r?r['风格场景'].slice(0,3).join(' · '):item.progress));const bottom=el('div',undefined,'card-bottom');bottom.append(el('span',statuses[item.status]||item.status,!r?'warn':''),el('span',item.sync?.status==='synced'?'飞书已同步 ↗':'查看档案 ↗'));info.append(bottom);card.append(visual,info);grid.append(card);}}
async function uploadFiles(files){const list=Array.from(files);if(!list.length)return;for(const file of list){if(!file.name.toLowerCase().endsWith('.pdf')){toast(file.name+'：请选择 PDF 文件',true);continue;}if(file.size>100*1024*1024){toast(file.name+' 超过 100 MB',true);continue;}const body=new FormData();body.append('file',file);await guarded(async()=>{const result=await api('/archives',{method:'POST',body});toast(file.name+(result.record?' 已在档案中':' 已接收，正在读取'));});}await refresh();location.hash='library';}
const zone=$('#dropzone');zone.onclick=()=>$('#pdf-input').click();zone.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();$('#pdf-input').click();}};zone.ondragover=e=>{e.preventDefault();zone.classList.add('dragover');};zone.ondragleave=()=>zone.classList.remove('dragover');zone.ondrop=e=>{e.preventDefault();zone.classList.remove('dragover');guarded(()=>uploadFiles(e.dataTransfer.files));};$('#pdf-input').onchange=e=>{guarded(()=>uploadFiles(e.target.files));e.target.value='';};$('#chat-attach').onclick=()=>$('#pdf-input').click();$('#search').oninput=renderLibrary;
async function loadDetail(id){const item=await api('/archives/'+id);if(detailId!==id)return;lastDetailStamp=item.updated_at;const r=item.record;const root=$('#detail-content');root.replaceChildren();const heading=el('div',undefined,'detail-heading');const title=el('div');title.append(el('p',r?'PLUGIN PROFILE':'MANUAL IN PROGRESS','eyebrow'),el('h1',r?.['名称']||item.filename));const tags=el('div',undefined,'tags');for(const tag of r?.['类属']||[])tags.append(el('span',tag,'tag'));title.append(tags);heading.append(title,el('span',statuses[item.status]||item.status,'status-pill'));root.append(heading);if(item.error)root.append(el('p',item.error,'notice error-text'));if(!r)root.append(el('p',item.progress,'notice'));if(item.sync?.bitable?.error)root.append(el('p','多维表格：'+item.sync.bitable.error,'notice error-text'));if(item.sync?.error)root.append(el('p','飞书同步：'+item.sync.error,'notice error-text'));const layout=el('div',undefined,'detail-grid'),main=el('div'),meta=el('aside',undefined,'detail-meta');if(r?.['界面图']){const visual=el('div',undefined,'detail-hero');const img=el('img');img.src='/api/archives/'+id+'/cover';img.alt=r['名称']+' 完整界面';visual.append(img);main.append(visual);}if(r){main.append(safeMarkdown(r['详细说明']));}else if(item.extraction){main.append(el('h2','已提取的图片'));const gallery=el('div',undefined,'gallery');for(const im of item.extraction.images.filter(n=>n.kind!=='page')){const figure=el('figure'),a=external('',fileUrl(id,im.path)),img=el('img');img.src=fileUrl(id,im.path);img.alt=im.id;img.loading='lazy';a.append(img);figure.append(a,el('figcaption',im.id+' · 第 '+im.page+' 页'));gallery.append(figure);}main.append(gallery);}const dl=el('dl');function field(label,value){dl.append(el('dt',label),el('dd',value));}if(r){field('风格场景',r['风格场景'].join(' · '));dl.append(el('dt','官网链接'));const dd=el('dd');dd.append(r['官网链接']?external('访问插件官网 ↗',r['官网链接']):document.createTextNode('手册未说明'));dl.append(dd);}field('原始手册',item.filename);field('读取页数',item.extraction?item.extraction.page_count+' 页':'读取中');field('飞书同步',({synced:'已同步',syncing:'同步中',failed:'未完成'}[item.sync?.status]||'尚未同步'));meta.append(dl);meta.append(external('打开原始 PDF ↗',fileUrl(id,'manual.pdf')));if(item.extraction){const pack=link('下载对话分析包 ↓','/api/archives/'+id+'/analysis-pack','file-button');pack.download='';meta.append(el('p'),pack);const edit=el('button',r?'修订归档结果':'导入分析结果','primary');edit.onclick=()=>openEditor(item);meta.append(el('p'),edit);const retry=el('button','使用模型重新分析');retry.disabled=['queued','extracting','analyzing'].includes(item.status);retry.onclick=()=>guarded(async()=>{await api('/archives/'+id+'/analyze',{method:'POST'});toast('已加入分析队列');await refresh();},retry);meta.append(el('p'),retry);}if(r){const tableSync=el('button','输出到多维表格');tableSync.disabled=item.sync?.bitable?.status==='syncing';tableSync.onclick=()=>guarded(async()=>{await api('/archives/'+id+'/sync-table',{method:'POST'});toast('表格同步已开始');await refresh();},tableSync);meta.append(el('p'),tableSync);if(item.sync?.bitable?.url)meta.append(el('p'),external('多维表格记录 ↗',item.sync.bitable.url));if(item.sync?.bitable?.preserved_fields?.length)meta.append(el('p','已保留表内手工修订：'+item.sync.bitable.preserved_fields.join('、'),'field-help'));const sync=el('button','同步到飞书');sync.disabled=item.sync?.status==='syncing';sync.onclick=()=>guarded(async()=>{await api('/archives/'+id+'/sync',{method:'POST'});toast('飞书同步已开始');await refresh();},sync);meta.append(el('p'),sync);meta.append(el('p'),link('下载详细说明 ↓',fileUrl(id,'details.md')));if(item.sync?.detail_url)meta.append(el('p'),external('飞书详情 ↗',item.sync.detail_url));if(item.sync?.summary_url)meta.append(el('p'),external('飞书汇总 ↗',item.sync.summary_url));}meta.append(el('p','每次修订会保存本地历史版本。','field-help'));layout.append(main,meta);root.append(layout);renderCloudPreview($('#cloud-detail'),item,r?[item]:[]);}
function openEditor(item){const value=item.record||{'界面图':null,'名称':'','类属':[],'风格场景':[],'官网链接':'','详细说明':'','evidence':[],'caveats':[]};$('#record-json').value=JSON.stringify(value,null,2);$('#edit-dialog').showModal();}
$('#close-editor').onclick=()=>$('#edit-dialog').close();$('#json-input').onchange=e=>guarded(async()=>{const file=e.target.files[0];if(file){if(file.size>1024*1024)throw Error('结果文件超过 1 MB');$('#record-json').value=await file.text();}e.target.value='';});$('#record-form').onsubmit=e=>{e.preventDefault();guarded(async()=>{let value;try{value=JSON.parse($('#record-json').value);}catch{throw Error('JSON 格式无效，请粘贴完整 JSON，不要包含代码围栏');}await api('/archives/'+detailId+'/record',{method:'POST',body:value});$('#edit-dialog').close();toast('已保存，档案已加入选用检索');await refresh();},e.submitter);};
function appendMessage(role,text,sources=[]){const div=el('div',undefined,'message '+role);div.append(el('b',role==='user'?'你':'选用助手'),el('p',text));for(const s of sources){if(s.url){div.append(link('↗ '+s.title,s.url,'source'));}else div.append(el('span','参考资料：'+s.title,'source'));}$('#chat-history').append(div);$('#chat-history').scrollTop=$('#chat-history').scrollHeight;return div;}
$('#chat-form').onsubmit=e=>{e.preventDefault();const input=$('#chat-input'),text=input.value.trim();if(!text)return;appendMessage('user',text);input.value='';const wait=appendMessage('assistant','正在查找收藏中的线索…');guarded(async()=>{try{const result=await api('/chat',{method:'POST',body:{message:text,history:history.slice(-12)}});wait.remove();appendMessage('assistant',result.answer,result.sources);history.push({role:'user',content:text},{role:'assistant',content:result.answer});}catch(error){wait.querySelector('p').textContent='没有完成本次检索：'+error.message;input.value=text;throw error;}},$('#chat-send'));};$$('[data-question]').forEach(button=>button.onclick=()=>{$('#chat-input').value=button.dataset.question;$('#chat-input').focus();});
async function saveForm(){const values={};const form=$('#settings-form');for(const field of form.elements){if(!field.name)continue;values[field.name]=field.type==='checkbox'?field.checked:field.type==='number'?Number(field.value):field.value.trim();}await api('/settings',{method:'POST',body:values});await loadSettings();}
$('#settings-form').onsubmit=e=>{e.preventDefault();guarded(async()=>{await saveForm();toast('设置已保存');},e.submitter);};
$('#authorize-feishu').onclick=e=>guarded(async()=>{await saveForm();const result=await api('/feishu/authorize',{method:'POST'});window.location.assign(result.url);},e.currentTarget);
$('#check-feishu').onclick=e=>guarded(async()=>{await saveForm();const result=await api('/feishu/check',{method:'POST'});toast((result.title||'汇总文档')+'：'+result.note);},e.currentTarget);
$('#import-summary').onclick=e=>guarded(async()=>{await saveForm();const result=await api('/feishu/import-summary',{method:'POST'});toast('已导入汇总知识，共 '+result.characters+' 字符');},e.currentTarget);
$('#knowledge-input').onchange=e=>guarded(async()=>{const file=e.target.files[0];if(!file)return;const body=new FormData();body.append('file',file);await api('/knowledge',{method:'POST',body});toast('基础知识已加入本地检索');e.target.value='';});
window.addEventListener('hashchange',route);
guarded(async()=>{await loadSettings();await refresh();route();});
let polling=false;setInterval(async()=>{if(polling||document.hidden)return;polling=true;try{await refresh();}catch{/* Keep drafts and current view intact if local server is briefly unavailable. */}finally{polling=false;}},3500);

$('#authorize-bitable').onclick=e=>guarded(async()=>{await saveForm();const result=await api('/bitable/authorize',{method:'POST'});window.location.assign(result.url);},e.currentTarget);
$('#setup-bitable').onclick=e=>guarded(async()=>{await saveForm();await api('/bitable/setup',{method:'POST'});await loadSettings();toast('插件表格和字段已就绪');},e.currentTarget);
