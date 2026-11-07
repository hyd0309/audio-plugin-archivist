"""Feishu OpenAPI adapter. Append-only, user OAuth, no delete/permission APIs."""
from pathlib import Path
from urllib.parse import urlencode, urlparse, quote
import hashlib
import json
import re
import secrets
import time
import uuid
import httpx
from filelock import FileLock
from .config import DATA, Settings
from .store import atomic_json

BASE = 'https://open.feishu.cn/open-apis'


class FeishuError(RuntimeError):
    pass


class UncertainWrite(FeishuError):
    pass


def resource_id(value: str, kind: str):
    if '://' in value:
        u = urlparse(value)
        if not (u.hostname == 'feishu.cn' or (u.hostname or '').endswith('.feishu.cn')):
            raise ValueError('请输入飞书链接或资源 ID')
        parts = u.path.strip('/').split('/')
        marker = 'docx' if kind == 'docx' else 'folder'
        if marker not in parts or len(parts) <= parts.index(marker)+1:
            raise ValueError('请使用飞书新版文档 /docx/ 或云空间 /folder/ 链接；Wiki 链接需先取得实际文档 ID')
        value = parts[parts.index(marker)+1]
    if not re.fullmatch(r'[A-Za-z0-9_-]{5,200}',value):
        raise ValueError('飞书资源 ID 格式无效')
    return value


class Feishu:
    def __init__(self, settings: Settings, transport=None):
        self.s = settings
        self.transport = transport
        self.token_path = DATA / 'feishu-tokens.json'
        DATA.mkdir(parents=True,exist_ok=True)

    def auth_url(self):
        if not (self.s.feishu_app_id and self.s.feishu_app_secret):
            raise FeishuError('请先填写飞书自建应用的 App ID 和 App Secret')
        state = secrets.token_urlsafe(32)
        atomic_json(DATA/'oauth-state.json',{'state':state,'expires':time.time()+600})
        return 'https://accounts.feishu.cn/open-apis/authen/v1/authorize?'+urlencode({
            'client_id':self.s.feishu_app_id,'redirect_uri':self.s.feishu_redirect_uri,
            'response_type':'code','state':state,'scope':self.s.feishu_scopes})

    def exchange(self, code, state):
        with FileLock(str(DATA/'oauth-state.lock')):
            path = DATA/'oauth-state.json'
            expected = json.loads(path.read_text('utf-8')) if path.exists() else {}
            if not state or not secrets.compare_digest(state,expected.get('state','')) or expected.get('expires',0)<time.time():
                raise FeishuError('授权请求已过期或不匹配，请从设置页重新发起授权')
            # Consume before exchange. Authorization codes must never be replayed.
            atomic_json(path,{'expires':0,'state':''})
            return self._token_request({'grant_type':'authorization_code','code':code,'redirect_uri':self.s.feishu_redirect_uri})

    def _token_request(self, extra):
        payload = {'client_id':self.s.feishu_app_id,'client_secret':self.s.feishu_app_secret,**extra}
        try:
            with httpx.Client(timeout=30,transport=self.transport) as client:
                response = client.post(BASE+'/authen/v2/oauth/token',json=payload)
                result = response.json()
            if response.status_code >= 400 or result.get('code',0) or not result.get('access_token'):
                raise FeishuError(f"飞书授权失败（HTTP {response.status_code}，代码 {result.get('code','unknown')}），请检查应用设置并重新授权")
            result['expires_at'] = time.time()+int(result.get('expires_in',7200))
            result['client_id'] = self.s.feishu_app_id
            atomic_json(self.token_path,result)
            return True
        except (httpx.HTTPError,ValueError) as error:
            # Refresh tokens rotate. Never blindly retry an ambiguous refresh.
            raise FeishuError('飞书授权连接中断，请重新授权；不会自动重复使用授权码或刷新令牌') from error

    def token(self):
        with FileLock(str(DATA/'feishu-token.lock')):
            if not self.token_path.exists():
                raise FeishuError('请先在设置页完成飞书用户授权')
            result = json.loads(self.token_path.read_text('utf-8'))
            if result.get('client_id') != self.s.feishu_app_id:
                raise FeishuError('应用已改变，请重新授权飞书')
            if result.get('expires_at',0)<time.time()+90:
                if not result.get('refresh_token') or result.get('refresh_uncertain'):
                    raise FeishuError('飞书授权已过期，请重新授权')
                result['refresh_uncertain']=True
                atomic_json(self.token_path,result)
                self._token_request({'grant_type':'refresh_token','refresh_token':result['refresh_token']})
                result = json.loads(self.token_path.read_text('utf-8'))
            return result['access_token']

    def request(self,method,path,**kwargs):
        headers = {'Authorization':'Bearer '+self.token()}
        try:
            with httpx.Client(timeout=60,transport=self.transport,follow_redirects=False) as client:
                response = client.request(method,BASE+path,headers=headers,**kwargs)
            if response.status_code >= 500 and method != 'GET':
                raise UncertainWrite('飞书服务端响应异常，写入结果不确定，请核对云端后恢复')
            try:
                result = response.json()
            except ValueError as e:
                raise UncertainWrite('飞书返回无法解析的响应，请核对云端状态') from e
            if response.status_code >= 400 or result.get('code',0):
                raise FeishuError(f"飞书操作失败（HTTP {response.status_code}，代码 {result.get('code','unknown')}）。请检查应用权限、文档编辑权和资源 ID")
            return result.get('data',result)
        except httpx.HTTPError as error:
            if method != 'GET':
                raise UncertainWrite('飞书连接中断，写入结果不确定。已保留步骤记录，请核对云端，避免重复新建') from error
            raise FeishuError('无法连接飞书，请检查网络后重试') from error

    def append(self,document_id,blocks,client_token):
        return self.request('POST',f'/docx/v1/documents/{document_id}/blocks/{document_id}/children',
                            params={'document_revision_id':-1,'client_token':client_token},json={'children':blocks,'index':-1})

    def document(self,document_id):
        return self.request('GET',f'/docx/v1/documents/{document_id}')

    def read_text(self,document_id):
        return self.request('GET',f'/docx/v1/documents/{document_id}/raw_content').get('content','')


def text_block(text,kind='text'):
    number = {'text':2,'heading1':3,'heading2':4,'heading3':5,'bullet':12,'ordered':13}[kind]
    return {'block_type':number,kind:{'elements':[{'text_run':{'content':text}}]}}


def markdown_blocks(markdown):
    result = []
    for line in markdown.splitlines():
        if not line.strip():
            continue
        match = re.match(r'^(#{1,3})\s+(.+)',line)
        kind = 'heading'+str(len(match[1])) if match else 'text'
        content = match[2] if match else line
        if not match and content.startswith('- '):
            kind,content='bullet',content[2:]
        for start in range(0,len(content),1500):
            result.append(text_block(content[start:start+1500],kind))
    return result


def reference_block(doc_id,title,mode='mention'):
    url = 'https://www.feishu.cn/docx/'+doc_id
    if mode == 'preview':
        # LinkPreview is exposed in the official SDK; tenant write support varies.
        # A rejected request is surfaced, never silently reported as embedded.
        return {'block_type':48,'link_preview':{'url':url,'url_type':'docx'}}
    return {'block_type':2,'text':{'elements':[{'mention_doc':{'token':doc_id,'obj_type':22,'url':quote(url,safe=''),'title':title}}]}}


class SyncJournal:
    def __init__(self,path:Path):
        self.path=path
        self.state=json.loads(path.read_text('utf-8')) if path.exists() else {}

    def step(self,key,action):
        step = self.state.get(key,{})
        if step.get('status')=='done':
            return step['result']
        if step.get('status')=='pending':
            raise UncertainWrite(f'步骤 {key} 的上次写入结果不确定，已暂停自动重试。请核对飞书与同步日志后恢复')
        request_id=step.get('request_id',str(uuid.uuid4()))
        self.state[key]={'status':'pending','request_id':request_id}
        atomic_json(self.path,self.state)
        try:
            result=action(request_id)
        except UncertainWrite:
            raise
        except FeishuError:
            self.state[key]['status']='failed'
            atomic_json(self.path,self.state)
            raise
        self.state[key].update(status='done',result=result)
        atomic_json(self.path,self.state)
        return result


def archive_fingerprint(settings,record):
    visible={key:value for key,value in record.items() if key not in {'筛选标签','evidence','caveats'}}
    summary=resource_id(settings.feishu_summary_id,'docx')
    destination=resource_id(settings.feishu_folder_token,'folder')
    return hashlib.sha256(json.dumps([visible,summary,destination,settings.feishu_reference_mode],
                                    ensure_ascii=False,sort_keys=True).encode()).hexdigest()


def sync_archive(settings,record,extraction,folder,progress=lambda _: None,client=None,previous=None):
    if not settings.feishu_ready:
        raise FeishuError('请配置飞书应用、详情文件夹、汇总文档并完成用户授权')
    fs=client or Feishu(settings)
    summary=resource_id(settings.feishu_summary_id,'docx')
    destination=resource_id(settings.feishu_folder_token,'folder')
    fingerprint=archive_fingerprint(settings,record)
    if previous and previous.get('fingerprint')==fingerprint and previous.get('detail_id'):
        fs.document(previous['detail_id'])
        if record['名称'] in fs.read_text(summary):
            return {**previous,'status':'synced','error':''}
    journal=SyncJournal(folder/'sync'/f'{fingerprint}.json')
    fs.document(summary)  # Read access check before any write.
    progress('正在创建飞书详情文档')
    document=journal.step('create_detail',lambda _:fs.request('POST','/docx/v1/documents',json={'title':record['名称'],'folder_token':destination}))
    doc_id=document['document']['document_id']
    blocks=markdown_blocks(record['详细说明'])
    for start in range(0,len(blocks),40):
        batch=blocks[start:start+40]
        journal.step(f'detail_{start}',lambda key,batch=batch:fs.append(doc_id,batch,key))
    progress('正在追加汇总条目和界面图')
    summary_blocks=[text_block(record['名称'],'heading2'),text_block('类属：'+' / '.join(record['类属'])),text_block('风格场景：'+' / '.join(record['风格场景']))]
    if record['官网链接']:
        summary_blocks.append({'block_type':2,'text':{'elements':[{'text_run':{'content':'官网：'+record['官网链接'],'text_element_style':{'link':{'url':record['官网链接']}}}}]}})
    else:
        summary_blocks.append(text_block('官网链接：手册未说明'))
    journal.step('summary_fields',lambda key:fs.append(summary,summary_blocks,key))
    if record.get('界面图'):
        candidate=next(im for im in extraction['images'] if im['id']==record['界面图'])
        path=folder/candidate['path']
        empty=journal.step('image_block',lambda key:fs.append(summary,[{'block_type':27,'image':{}}],key))
        block_id=empty['children'][0]['block_id']
        def upload(_):
            with path.open('rb') as stream:
                return fs.request('POST','/drive/v1/medias/upload_all',data={'file_name':path.name,'parent_type':'docx_image','parent_node':block_id,'size':str(path.stat().st_size)},files={'file':(path.name,stream,'image/png')})
        media=journal.step('image_upload',upload)
        journal.step('image_bind',lambda _:fs.request('PATCH',f'/docx/v1/documents/{summary}/blocks/{block_id}',params={'document_revision_id':-1},json={'replace_image':{'token':media['file_token']}}))
    else:
        journal.step('missing_image',lambda key:fs.append(summary,[text_block('界面图：手册未提供可用图片')],key))
    reference=journal.step('detail_reference',lambda key:fs.append(summary,[reference_block(doc_id,record['名称'],settings.feishu_reference_mode)],key))
    # Read back the detail metadata and summary text, instead of trusting writes alone.
    fs.document(doc_id)
    summary_text=fs.read_text(summary)
    if record['名称'] not in summary_text:
        raise FeishuError('写入已返回成功，但汇总读回未找到名称；请稍后重新核验，不会重复追加已完成步骤')
    # Feishu returns the canonical tenant URL in the native document mention.
    # Preserve that host for links opened from the local UI.
    origin='https://www.feishu.cn'
    if '://' in settings.feishu_summary_id:
        origin='https://'+urlparse(settings.feishu_summary_id).netloc
    for child in reference.get('children',[]):
        for element in child.get('text',{}).get('elements',[]):
            mention=element.get('mention_doc',{})
            if mention.get('token')==doc_id and mention.get('url'):
                from urllib.parse import unquote
                candidate=unquote(mention['url'])
                if resource_id(candidate,'docx')==doc_id:
                    origin='https://'+urlparse(candidate).netloc
    return {'status':'synced','detail_id':doc_id,'detail_url':origin+'/docx/'+doc_id,
            'summary_url':origin+'/docx/'+summary,'reference_mode':settings.feishu_reference_mode,
            'fingerprint':fingerprint,'error':''}
