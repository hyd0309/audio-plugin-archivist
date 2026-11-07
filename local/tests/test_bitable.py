import copy
import json
import pytest
from audio_archive import bitable, config, store
from audio_archive.feishu import FeishuError, UncertainWrite
from audio_archive.models import FilterTags


class Cloud:
    """Stateful API double: fields and records survive successive adapter calls."""
    def __init__(self):
        self.fields=[]
        for i,field in enumerate(bitable.field_specs()):
            field=copy.deepcopy(field)
            field['field_id']='field'+str(i)
            for j,option in enumerate(field.get('property',{}).get('options',[])):
                option['id']='option'+str(i)+'x'+str(j)
            self.fields.append(field)
        self.views=[{'view_id':'view00','view_name':'全部插件','view_type':'grid'}]
        self.records=[]
        self.writes=[]
        self.fail_after_create=False

    def request(self, method,path,**kw):
        if method!='GET':
            self.writes.append((method,path,copy.deepcopy(kw.get('json'))))
        if path.endswith('/apps'):
            return {'app':{'app_token':'app123','url':'https://example.feishu.cn/base/app123'}}
        if path.endswith('/apps/app123'):
            return {'app':{'app_token':'app123','url':'https://example.feishu.cn/base/app123'}}
        if path.endswith('/tables'):
            return {'table_id':'table123'}
        if path.endswith('/fields'):
            return {'items':copy.deepcopy(self.fields)}
        if path.endswith('/views'):
            if method=='GET':return {'items':copy.deepcopy(self.views)}
            view={'view_id':'view'+str(len(self.views)),**kw['json']}
            self.views.append(view)
            return {'view':copy.deepcopy(view)}
        if '/views/' in path:
            return {'view':kw.get('json',{})}
        if path.endswith('/upload_all'):
            return {'file_token':'file'+str(len(self.writes))}
        if path.endswith('/records'):
            if method=='GET':return {'items':copy.deepcopy(self.records)}
            item={'record_id':'record'+str(len(self.records)),**kw['json']}
            self.records.append(item)
            if self.fail_after_create:
                self.fail_after_create=False
                raise UncertainWrite('response lost after server committed')
            return {'record':copy.deepcopy(item)}
        if '/records/' in path:
            item=next(r for r in self.records if r['record_id']==path.rsplit('/',1)[1])
            if method=='PUT':item['fields'].update(copy.deepcopy(kw['json']['fields']))
            return {'record':copy.deepcopy(item)}
        raise AssertionError((method,path))


@pytest.fixture
def table_item(workspace,record):
    item=store.create('a'*64,'manual.pdf')
    folder=store.folder(item['id']);folder.mkdir(parents=True,exist_ok=True)
    (folder/'manual.pdf').write_bytes(b'%PDF-test')
    (folder/'image.png').write_bytes(b'png')
    store.atomic_json(folder/'extraction.json',{'page_count':1,'pages':[{'number':1,'text':'This chorus is designed for electric guitar.'}],
        'images':[{'id':'img1','path':'image.png'}]})
    item['record']={**record,'界面图':'img1','类属':['Chorus','合唱效果'],
        '风格场景':['复古合唱','展宽'],'筛选标签':{'厂商':'Test Audio','适用音源':[],'音源依据':[]}}
    item['sync']={'detail_url':'https://example.feishu.cn/docx/detail123'}
    return item


def configured():
    return config.Settings(bitable_app_token='app123',bitable_table_id='table123',
                           bitable_url='https://example.feishu.cn/base/app123')


def test_setup_resume_preserves_views(workspace):
    cloud=Cloud()
    settings=config.save_settings({'feishu_folder_token':'folder123'})
    result=bitable.setup(settings,cloud)
    assert len(result['fields'])==13 and len(result['views'])==5
    count=len(cloud.writes)
    bitable.setup(config.get_settings(),cloud)
    assert len(cloud.writes)==count
    patches=[body for method,path,body in cloud.writes if method=='PATCH']
    assert all('filter_info' not in p['property'] for p in patches)
    gallery=next(v for v in cloud.views if v['view_type']=='gallery')
    assert not any(method=='PATCH' and path.endswith('/'+gallery['view_id']) for method,path,_ in cloud.writes)
    assert all(method!='DELETE' for method,_,_ in cloud.writes)


def test_upsert_and_personal_edits_preserved(table_item):
    cloud=Cloud();settings=configured()
    result=bitable.sync_item(table_item,settings,cloud)
    row=cloud.records[0]['fields']
    assert row['类属']==['合唱']
    assert row['风格场景']==['复古合唱','立体声展宽']
    assert row['适用音源']==[]
    assert row['详情文档']['link'].endswith('detail123')
    assert row['界面图'] and '原始手册' not in row
    count=len(cloud.writes);stamp=row['最后同步时间']
    assert bitable.sync_item(table_item,settings,cloud)['record_id']==result['record_id']
    assert len(cloud.writes)==count and row['最后同步时间']==stamp
    row.update({'风格场景':['我的选项'],'个人备注':'保留我的试听记录'})
    table_item['record']['详细说明']+='\n新的手册说明'
    result=bitable.sync_item(table_item,settings,cloud)
    assert '风格场景' in result['preserved_fields']
    assert row['风格场景']==['我的选项']
    assert row['个人备注']=='保留我的试听记录'
    assert row['详细说明'].endswith('新的手册说明')
    row['类属']=['手工类别']
    table_item['record']['类属']=['新类别']
    bitable.sync_item(table_item,settings,cloud)
    assert row['类属']==['手工类别']
    assert len(cloud.records)==1


def test_update_can_reapply_same_change_after_cloud_reversion(table_item):
    cloud=Cloud();s=configured()
    bitable.sync_item(table_item,s,cloud)
    row=cloud.records[0]['fields'];original=row['详细说明']
    table_item['record']['详细说明']+=' more'
    bitable.sync_item(table_item,s,cloud)
    row['详细说明']=original
    bitable.sync_item(table_item,s,cloud)
    assert row['详细说明'].endswith(' more')


def test_uncertain_create_recovers_by_product_id(table_item):
    cloud=Cloud();cloud.fail_after_create=True
    with pytest.raises(UncertainWrite):bitable.sync_item(table_item,configured(),cloud)
    bitable.sync_item(table_item,configured(),cloud)
    assert len(cloud.records)==1
    assert sum(method=='POST' and path.endswith('/records') for method,path,_ in cloud.writes)==1


def test_missing_or_duplicate_cloud_record_does_not_create_more(table_item):
    cloud=Cloud();s=configured()
    bitable.sync_item(table_item,s,cloud)
    cloud.records.append(copy.deepcopy(cloud.records[0]))
    with pytest.raises(FeishuError,match='多个'):bitable.sync_item(table_item,s,cloud)
    cloud.records=[]
    with pytest.raises(FeishuError,match='不存在'):bitable.sync_item(table_item,s,cloud)
    assert sum(method=='POST' and path.endswith('/records') for method,path,_ in cloud.writes)==1


def test_existing_user_option_priority_and_legacy_tags(record):
    field={'property':{'options':[{'name':'Chorus'}]}}
    assert bitable.normalized_options(['chorus','Chorus','新标签','新标签'],field)==['Chorus','新标签']
    assert bitable.profile(record)['适用音源']==[]
    assert bitable.profile(record)['类属']==record['类属']
    with pytest.raises(ValueError):FilterTags(主类属='调制')


def test_source_requires_exact_manual_evidence_before_cloud_writes(table_item):
    cloud=Cloud();s=configured()
    tags=table_item['record']['筛选标签']
    tags['适用音源']=['电吉他']
    with pytest.raises(ValueError,match='原文依据'):bitable.sync_item(table_item,s,cloud)
    assert cloud.writes==[]
    tags['音源依据']=[{'source':'电吉他','page':1,'quote':'This chorus is designed for electric guitar.'}]
    bitable.sync_item(table_item,s,cloud)
    assert cloud.records[0]['fields']['适用音源']==['电吉他']
    tags['音源依据'][0]['quote']='This chorus is designed for drums.'
    count=len(cloud.writes)
    with pytest.raises(ValueError,match='原文引用'):bitable.sync_item(table_item,s,cloud)
    assert len(cloud.writes)==count
