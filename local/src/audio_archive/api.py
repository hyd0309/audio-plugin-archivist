from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlparse
import hashlib
import io
import json
import zipfile
from fastapi import FastAPI, UploadFile, File, BackgroundTasks, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse, HTMLResponse
from starlette.middleware.trustedhost import TrustedHostMiddleware
from filelock import FileLock, Timeout
from pydantic import ValidationError
from .config import ROOT, DATA, get_settings, public_settings, save_settings
from . import store, workflow
from .models import ChatRequest
from .search import recommend
from .feishu import Feishu, FeishuError, resource_id


@asynccontextmanager
async def lifespan(app):
    DATA.mkdir(parents=True,exist_ok=True)
    with FileLock(str(DATA/'service.lock'),timeout=0):
        store.initialize()
        yield


app=FastAPI(title='音频效果器归档及选用助手',lifespan=lifespan,docs_url='/api/docs',redoc_url=None)
app.add_middleware(TrustedHostMiddleware,allowed_hosts=['127.0.0.1','localhost','[::1]'])


@app.middleware('http')
async def same_origin(request:Request,call_next):
    if request.method not in {'GET','HEAD','OPTIONS'}:
        origin=request.headers.get('origin')
        if request.headers.get('x-archive-request')!='1' or (origin and urlparse(origin).netloc != request.headers.get('host')):
            return JSONResponse({'detail':'请从本地工作台发起此操作'},status_code=403)
    response=await call_next(request)
    response.headers['X-Content-Type-Options']='nosniff'
    response.headers['Referrer-Policy']='no-referrer'
    response.headers['Cache-Control']='no-store'
    response.headers['Content-Security-Policy']="default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'"
    return response


@app.exception_handler(ValueError)
async def value_error(request,error):
    return JSONResponse({'detail':str(error)[:1500]},status_code=400)


@app.exception_handler(KeyError)
async def missing(request,error):
    return JSONResponse({'detail':'未找到档案'},status_code=404)


@app.exception_handler(FeishuError)
async def feishu_error(request,error):
    return JSONResponse({'detail':str(error)},status_code=400)


@app.exception_handler(Timeout)
async def busy(request,error):
    return JSONResponse({'detail':'该档案正在处理，请等待完成'},status_code=409)


@app.get('/')
def index():
    return FileResponse(ROOT/'web/index.html')


@app.get('/assets/{name}')
def asset(name:str):
    if name not in {'app.js','style.css'}:
        raise HTTPException(404)
    return FileResponse(ROOT/'web'/name)


@app.get('/api/health')
def health():
    return {'ok':True,'service':'audio-plugin-archivist'}


@app.get('/api/settings')
def settings():
    result=public_settings()
    path=DATA/'feishu-tokens.json'
    tokens=json.loads(path.read_text('utf-8')) if path.exists() else {}
    result['feishu_authorized']=bool(tokens.get('access_token') and tokens.get('client_id')==result['feishu_app_id'])
    result['bitable_authorized']=result['feishu_authorized'] and 'bitable:app' in tokens.get('scope','').split()
    return result


@app.post('/api/settings')
def settings_save(values:dict):
    # Validation errors must not echo secrets via Pydantic's input field.
    try:
        save_settings(values)
    except ValidationError as error:
        raise HTTPException(400,'；'.join(e['msg'] for e in error.errors(include_input=False)))
    return settings()


@app.get('/api/archives')
def archives():
    return store.all_items()


@app.post('/api/archives')
async def upload(background:BackgroundTasks,file:UploadFile=File(...)):
    raw=await file.read(100*1024*1024+1)
    item=workflow.ingest(raw,file.filename or 'manual.pdf')
    if item['status']=='queued':
        background.add_task(workflow.process,item['id'])
    return item


@app.get('/api/archives/{item_id}')
def detail(item_id:str):
    result=store.get(item_id)
    path=store.folder(item_id)/'extraction.json'
    if path.exists():
        ex=json.loads(path.read_text('utf-8'))
        result['extraction']={'page_count':ex['page_count'],'images':ex['images'],'warnings':ex['warnings']}
    return result


@app.post('/api/archives/{item_id}/analyze')
def analyze(item_id:str,background:BackgroundTasks):
    item=store.get(item_id)
    if item['status'] in {'extracting','analyzing','queued'}:
        return {'queued':True}
    store.update(item_id,status='queued',progress='等待分析',error='')
    background.add_task(workflow.process,item_id)
    return {'queued':True}


@app.post('/api/archives/{item_id}/record')
def import_record(item_id:str,value:dict,background:BackgroundTasks):
    store.get(item_id)
    if not (store.folder(item_id)/'extraction.json').exists():
        raise HTTPException(409,'请先完成 PDF 提取')
    result=workflow.import_record(item_id,value)
    if get_settings().bitable_auto_sync:
        background.add_task(workflow.sync_table,item_id)
    return result


@app.post('/api/archives/{item_id}/sync')
def sync(item_id:str,background:BackgroundTasks):
    item=store.get(item_id)
    if not item['record']:
        raise HTTPException(400,'请先完成档案')
    if not get_settings().feishu_ready:
        raise HTTPException(400,'请先在设置中配置飞书应用和目标文档')
    background.add_task(workflow.sync,item_id)
    return {'queued':True}


@app.get('/api/archives/{item_id}/files/{name:path}')
def files(item_id:str,name:str):
    root=store.folder(item_id).resolve()
    path=(root/name).resolve()
    allowed= name in {'manual.pdf','record.json','details.md','extracted.txt'} or (name.startswith(('pages/','images/')) and path.suffix=='.png')
    if not path.is_relative_to(root) or not allowed or not path.is_file():
        raise HTTPException(404)
    return FileResponse(path)


@app.get('/api/archives/{item_id}/cover')
def cover(item_id:str):
    item=store.get(item_id)
    root=store.folder(item_id)
    if not item['record'] or not item['record'].get('界面图'):
        raise HTTPException(404)
    extraction=json.loads((root/'extraction.json').read_text('utf-8'))
    image=next((im for im in extraction['images'] if im['id']==item['record']['界面图']),None)
    if image is None:
        raise HTTPException(404)
    return files(item_id,image['path'])


@app.get('/api/archives/{item_id}/analysis-pack')
def analysis_pack(item_id:str):
    target=store.folder(item_id)
    if not (target/'extraction.json').exists():
        raise HTTPException(409,'PDF 尚未提取完成')
    extraction=json.loads((target/'extraction.json').read_text('utf-8'))
    memory=io.BytesIO()
    with zipfile.ZipFile(memory,'w',zipfile.ZIP_DEFLATED) as bundle:
        for name in ('manual.pdf','extracted.txt','extraction.json'):
            bundle.write(target/name,name)
        for image in extraction['images']:
            bundle.write(target/image['path'],image['path'])
        instructions=(ROOT/'prompts/archive.md').read_text('utf-8')+'\n\n请结合 manual.pdf、页面图片与 extraction.json 的候选图片 ID 生成 record.json。界面图使用实际 ID，不使用文件路径。完成后回到本地工作台“导入分析结果”。\n'
        bundle.writestr('分析说明.md',instructions)
    memory.seek(0)
    return StreamingResponse(memory,media_type='application/zip',headers={'Content-Disposition':f'attachment; filename="analysis-{item_id[:8]}.zip"'})


@app.post('/api/chat')
def chat(value:ChatRequest):
    try:
        return recommend(get_settings(),value.message,value.history)
    except Exception as error:
        raise HTTPException(400,workflow.safe_error(error))


@app.post('/api/knowledge')
async def knowledge(file:UploadFile=File(...)):
    if Path(file.filename or '').suffix.lower() not in {'.md','.txt'}:
        raise HTTPException(400,'基础知识目前支持 UTF-8 的 Markdown 和 TXT')
    raw=await file.read(5*1024*1024+1)
    if len(raw)>5*1024*1024:
        raise HTTPException(400,'资料最大支持 5 MB')
    try:
        text=raw.decode('utf-8-sig')
    except UnicodeDecodeError:
        raise HTTPException(400,'请将资料保存为 UTF-8 编码后导入')
    folder=DATA/'knowledge'
    folder.mkdir(exist_ok=True)
    name=hashlib.sha256(raw).hexdigest()[:16]+'.md'
    path=folder/name
    if not path.exists():
        path.write_text('# '+Path(file.filename.replace('\\','/')).name+'\n\n'+text,'utf-8')
    return {'ok':True,'name':name}


@app.post('/api/feishu/authorize')
def authorize():
    return {'url':Feishu(get_settings()).auth_url()}


@app.post('/api/bitable/authorize')
def authorize_bitable():
    s=get_settings()
    scopes=' '.join(dict.fromkeys([*s.feishu_scopes.split(),'bitable:app']))
    s=save_settings({'feishu_scopes':scopes})
    return {'url':Feishu(s).auth_url()}


@app.post('/api/bitable/setup')
def setup_bitable():
    from .bitable import setup
    return setup(get_settings())


@app.post('/api/archives/{item_id}/sync-table')
def sync_bitable(item_id:str,background:BackgroundTasks):
    if not store.get(item_id)['record']:
        raise HTTPException(400,'请先完成档案')
    if not get_settings().bitable_table_id:
        raise HTTPException(400,'请先在设置页创建多维表格')
    background.add_task(workflow.sync_table,item_id)
    return {'queued':True}


@app.get('/api/feishu/callback')
def callback(code:str='',state:str='',error:str=''):
    if error:
        return HTMLResponse('未完成授权，请返回工作台重新发起。',status_code=400)
    Feishu(get_settings()).exchange(code,state)
    return HTMLResponse('<meta charset="utf-8"><p>飞书授权完成。可以回到本地工作台。</p><a href="/">返回工作台</a>')


@app.post('/api/feishu/check')
def check_feishu():
    s=get_settings()
    doc=resource_id(s.feishu_summary_id,'docx')
    result=Feishu(s).document(doc)
    return {'ok':True,'title':result.get('document',{}).get('title',''),'note':'已验证授权及汇总文档可读；实际写入仍需编辑权限'}


@app.post('/api/feishu/import-summary')
def import_summary():
    s=get_settings()
    doc=resource_id(s.feishu_summary_id,'docx')
    text=Feishu(s).read_text(doc)
    folder=DATA/'knowledge'
    folder.mkdir(exist_ok=True)
    digest=hashlib.sha256(text.encode()).hexdigest()[:16]
    path=folder/f'飞书汇总-{digest}.md'
    if not path.exists():
        path.write_text('# 飞书汇总快照\n\n来源：https://www.feishu.cn/docx/'+doc+'\n\n'+text,'utf-8')
    return {'ok':True,'characters':len(text)}
