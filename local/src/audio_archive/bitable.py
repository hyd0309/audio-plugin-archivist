"""User-authorized Bitable output, resumable setup and non-destructive upserts."""
import hashlib
import json
import re
import unicodedata
from urllib.parse import urlparse
from filelock import FileLock
from . import store
from .config import save_settings
from .feishu import Feishu, FeishuError, SyncJournal, resource_id
from .figures import detail_parts
from .models import FilterTags

FIELDS = [
    ('名称',1),('厂商',1),('界面图',17),('类属',4),('适用音源',4),('风格场景',4),
    ('官网链接',15),('详情文档',15),('详细说明',1),
    ('个人备注',1),('插件ID',1),('源PDF指纹',1),('最后同步时间',5),
]
TYPES = dict(FIELDS)
TAG_FIELDS = ['厂商','类属','适用音源','风格场景']
ALIASES = {'chorus':'合唱','合唱效果':'合唱','modulation':'调制','合唱(chorus)':'合唱',
           '扩宽':'立体声展宽','展宽':'立体声展宽','stereo widening':'立体声展宽','vintage':'复古'}


def digest(value):
    return hashlib.sha256(json.dumps(value,ensure_ascii=False,sort_keys=True).encode()).hexdigest()


def identifier(value):
    if not re.fullmatch(r'[A-Za-z0-9_-]{5,200}',value):
        raise ValueError('多维表格标识无效')
    return value


def all_pages(fs,path,**params):
    result=[]
    while True:
        page=fs.request('GET',path,params={'page_size':100,**params})
        result.extend(page.get('items',[]))
        if not page.get('has_more'):
            return result
        params['page_token']=page['page_token']


def field_specs():
    result=[]
    for name,kind in FIELDS:
        field={'field_name':name,'type':kind}
        if kind==5:
            field['property']={'date_formatter':'yyyy/MM/dd','auto_fill':False}
        result.append(field)
    return result


def setup(settings,client=None):
    fs=client or Feishu(settings)
    with FileLock(str(store.DATA/'bitable.lock')):
        journal=SyncJournal(store.DATA/'bitable-setup.json')
        if settings.bitable_app_token:
            app_token=identifier(settings.bitable_app_token)
            app=fs.request('GET',f'/bitable/v1/apps/{app_token}')['app']
        else:
            app=journal.step('create_app',lambda _:fs.request('POST','/bitable/v1/apps',json={
                'name':'效果器档案室','folder_token':resource_id(settings.feishu_folder_token,'folder')}))['app']
            app_token=identifier(app['app_token'])
            save_settings({'bitable_app_token':app_token,'bitable_url':app.get('url','')})
        root=f'/bitable/v1/apps/{app_token}'
        if settings.bitable_table_id:
            table_id=identifier(settings.bitable_table_id)
        else:
            table=journal.step('create_table_'+app_token,lambda _:fs.request('POST',root+'/tables',json={
                'table':{'name':'插件档案','default_view_name':'全部插件','fields':field_specs()}}))
            table_id=identifier(table['table_id'])
            save_settings({'bitable_table_id':table_id})
        table_root=root+'/tables/'+table_id
        fields=all_pages(fs,table_root+'/fields')
        by_name={field['field_name']:field for field in fields}
        for name,kind in FIELDS:
            if name not in by_name or by_name[name]['type']!=kind:
                raise FeishuError('表结构不匹配：'+name+'；请恢复该字段，已有列不会被删除或转换')
        views=all_pages(fs,table_root+'/views')
        for name,view_type in [('按类属浏览','grid'),('看界面找插件','gallery'),('按风格场景浏览','grid'),('按音源浏览','grid')]:
            if not any(v['view_name']==name for v in views):
                view=journal.step('view_'+table_id+'_'+name,lambda _,n=name,t=view_type:fs.request('POST',table_root+'/views',json={'view_name':n,'view_type':t}))['view']
                views.append(view)
        for view in views:
            # Public v1 PATCH supports grid views; gallery is created but configured in UI.
            if view.get('view_type')!='grid':
                continue
            if view['view_name'] not in {'全部插件','按类属浏览','看界面找插件','按风格场景浏览','按音源浏览'}:
                continue
            properties={'hidden_fields':[by_name[n]['field_id'] for n in
                ('详细说明','插件ID','源PDF指纹','最后同步时间')]}
            # Initialize once: later setup calls preserve the user's view customizations.
            journal.step('configure_v2_'+view['view_id'],lambda _,v=view,p=properties:
                fs.request('PATCH',table_root+'/views/'+v['view_id'],json={'property':p}))
        url=app.get('url') or settings.bitable_url
        if not url:
            host=urlparse(settings.feishu_summary_id).netloc or 'www.feishu.cn'
            url='https://'+host+'/base/'+app_token
        save_settings({'bitable_app_token':app_token,'bitable_table_id':table_id,'bitable_url':url})
        result={'app_token':app_token,'table_id':table_id,'url':url,'fields':fields,'views':views}
        store.atomic_json(store.DATA/'bitable-schema.json',result)
        return result


def plain(value):
    if isinstance(value,list) and all(isinstance(v,dict) and 'text' in v for v in value):
        return ''.join(v['text'] for v in value)
    return value


def canonical(value,kind):
    value=plain(value)
    if kind==17:
        return sorted(v['file_token'] for v in (value or []))
    if kind==15:
        return (value or {}).get('link','')
    if kind==4:
        return sorted(value or [])
    return value if value is not None else ''


def normalized_options(values,field):
    existing={v['name'].casefold():v['name'] for v in field.get('property',{}).get('options',[])}
    result=[]
    for value in values:
        value=unicodedata.normalize('NFKC',value).strip()
        # Exact user-created options take priority over our alias dictionary.
        value=existing.get(value.casefold(),ALIASES.get(value.casefold(),value))
        value=existing.get(value.casefold(),value)
        if value and value not in result:
            result.append(value)
    return result


def profile(record):
    tags=FilterTags.model_validate(record.get('筛选标签') or {})
    return {'厂商':tags.厂商,'适用音源':tags.适用音源,
            '类属':record['类属'],'风格场景':record['风格场景']}


def product_id(item):
    path=store.folder(item['id'])/'product-id.json'
    if path.exists():
        return json.loads(path.read_text('utf-8'))['id']
    r=item['record'];p=profile(r)
    key=[unicodedata.normalize('NFKC',x).strip().casefold() for x in (p['厂商'],r['名称'])]
    value='plugin-'+digest(key)[:32]
    store.atomic_json(path,{'id':value,'identity':key})
    return value


def find_record(fs,root,pid):
    # GET pagination is read-only and avoids URL filter escaping and search side effects.
    matches=[r for r in all_pages(fs,root+'/records') if plain(r.get('fields',{}).get('插件ID'))==pid]
    if len(matches)>1:
        raise FeishuError('发现多个相同插件ID的表格记录，请先核对；不会自动删除任何记录')
    return matches[0] if matches else None


def sync_item(item,settings,client=None):
    if not (settings.bitable_app_token and settings.bitable_table_id):
        raise FeishuError('请先在设置页创建插件多维表格')
    record=item['record']
    if not record:
        raise ValueError('请先完成归档')
    # Validate again before any cloud write, including previously stored records.
    from .models import Archive
    from .llm import validate_record
    folder=store.folder(item['id'])
    extraction=json.loads((folder/'extraction.json').read_text('utf-8'))
    validate_record(Archive.model_validate(record),extraction)
    fs=client or Feishu(settings)
    app=identifier(settings.bitable_app_token);table=identifier(settings.bitable_table_id)
    root=f'/bitable/v1/apps/{app}/tables/{table}'
    fields={f['field_name']:f for f in all_pages(fs,root+'/fields')}
    for name,kind in FIELDS:
        if name not in fields or fields[name]['type']!=kind:
            raise FeishuError('多维表格字段缺失或类型改变：'+name)
    pid=product_id(item)
    state_dir=store.DATA/'bitable-records'/app/table
    mapping_path=state_dir/(pid+'.json')
    mapping=json.loads(mapping_path.read_text('utf-8')) if mapping_path.exists() else {}
    current=find_record(fs,root,pid)
    existing=(current or {}).get('fields',{})
    if mapping.get('record_id') and not current:
        raise FeishuError('原表格记录已不存在或插件ID被修改，请核对后恢复；不会自动复制新记录')
    description='\n'.join(text for text, _ in detail_parts(record['详细说明']))
    incoming={'名称':record['名称'],**profile(record),'详细说明':description,
              '插件ID':pid,'源PDF指纹':item['id']}
    for name in ('类属','适用音源','风格场景'):
        incoming[name]=normalized_options(incoming[name],fields[name])
    incoming['官网链接']={'text':'官网','link':record['官网链接']} if record['官网链接'] else None
    detail_url=(item.get('sync') or {}).get('detail_url')
    if detail_url:
        incoming['详情文档']={'text':'详细说明文档','link':detail_url}
    files=[]
    if record.get('界面图'):
        candidate=next(im for im in extraction['images'] if im['id']==record['界面图'])
        files.append(('界面图',folder/candidate['path'],'bitable_image','image/png'))
    else:
        incoming['界面图']=[]
    uploads=SyncJournal(state_dir/(pid+'-uploads.json'))
    for name,path,parent_type,mime in files:
        file_hash=hashlib.sha256(path.read_bytes()).hexdigest()
        def upload(_,path=path,parent_type=parent_type,mime=mime):
            with path.open('rb') as stream:
                return fs.request('POST','/drive/v1/medias/upload_all',data={'file_name':path.name,'parent_type':parent_type,
                    'parent_node':app,'size':str(path.stat().st_size)},files={'file':(path.name,stream,mime)})
        media=uploads.step(name+'-'+file_hash,upload)
        incoming[name]=[{'file_token':media['file_token']}]
    preserved=[]
    last=mapping.get('last_written',{})
    for name in TAG_FIELDS:
        if current and name in last and canonical(existing.get(name),TYPES[name])!=canonical(last[name],TYPES[name]):
            incoming.pop(name,None)
            preserved.append(name)
    changed={k:v for k,v in incoming.items() if not current or canonical(v,TYPES[k])!=canonical(existing.get(k),TYPES[k])}
    if changed:
        import time
        changed['最后同步时间']=int(time.time()*1000)
        # Creates are journaled; updates are absolute assignments and can safely be
        # retried after reading current values, including after an ambiguous response.
        signature=digest([incoming,{k:canonical(existing.get(k),TYPES[k]) for k in incoming}])
        journal=SyncJournal(state_dir/(pid+'-writes.json'))
        if current:
            rid=identifier(current['record_id'])
            result=fs.request('PUT',root+'/records/'+rid,json={'fields':changed})
        else:
            result=journal.step(signature,lambda key:fs.request('POST',root+'/records',params={'client_token':key},json={'fields':changed}))
        rid=result['record']['record_id']
    else:
        rid=current['record_id']
    verified=fs.request('GET',root+'/records/'+identifier(rid))['record']
    for name,value in incoming.items():
        if canonical(verified['fields'].get(name),TYPES[name])!=canonical(value,TYPES[name]):
            raise FeishuError('多维表格读回校验失败：'+name+'；已有写入保留，可核对后重试')
    store.atomic_json(mapping_path,{'record_id':rid,'last_written':{**last,**incoming},'source':item['id']})
    url=settings.bitable_url.split('?')[0]+f'?table={table}&record={rid}'
    return {'status':'synced','record_id':rid,'url':url,'product_id':pid,'preserved_fields':preserved,'error':''}
