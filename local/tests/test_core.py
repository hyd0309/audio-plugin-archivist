import hashlib
import json
import zipfile
import io
import pytest
from fastapi.testclient import TestClient
from audio_archive import store, workflow, config
from audio_archive.models import Archive
from audio_archive.llm import validate_record, VisionModel
from audio_archive.search import retrieve, recommend
from audio_archive.api import app


def test_pdf_roundtrip_and_dedup(workspace,pdf_bytes,record):
    first=workflow.ingest(pdf_bytes,'manual.pdf')
    second=workflow.ingest(pdf_bytes,'renamed.pdf')
    assert first['id']==second['id']
    assert len(store.all_items())==1
    workflow.process(first['id'])
    item=store.get(first['id'])
    assert item['status']=='awaiting_model' and item['record'] is None
    folder=store.folder(item['id'])
    ex=json.loads((folder/'extraction.json').read_text('utf-8'))
    assert ex['page_count']==2
    assert len(list((folder/'pages').glob('*.png')))==2
    assert 'Stereo Spread' in ex['pages'][1]['text']
    assert (folder/'manual.pdf').read_bytes()==pdf_bytes
    workflow.import_record(item['id'],record)
    assert store.get(item['id'])['record']==record
    record['详细说明']+='\n新增用户核对内容。'
    workflow.import_record(item['id'],record)
    assert len(list((folder/'versions').glob('*.json')))==2


def test_bad_pdf_and_path_rejected(workspace):
    with pytest.raises(ValueError):
        workflow.ingest(b'not PDF','fake.pdf')
    with pytest.raises(ValueError):
        store.folder('../settings.json')


def test_validation_rejects_untrusted_urls_images_and_pages(record):
    with pytest.raises(ValueError):
        Archive.model_validate({**record,'官网链接':'javascript:alert(1)'})
    with pytest.raises(ValueError):
        Archive.model_validate({**record,'名称':'  '})
    with pytest.raises(ValueError):
        validate_record(Archive.model_validate({**record,'界面图':'../../secrets'}),{'images':[],'page_count':2})
    with pytest.raises(ValueError):
        validate_record(Archive.model_validate(record),{'images':[],'page_count':0})


def test_retrieval_and_no_invented_inventory(workspace,pdf_bytes,record):
    item=workflow.ingest(pdf_bytes,'manual.pdf');workflow.process(item['id']);workflow.import_record(item['id'],record)
    found=retrieve('干净电吉他增厚和展宽')
    assert found and found[0]['id']==item['id']
    result=recommend(config.Settings(),'合唱效果',[])
    assert result['mode']=='local_search'
    assert '尚未经过模型判断' in result['answer']
    assert result['sources'][0]['id']==item['id']
    assert retrieve('量子纠缠实验')==[]


def test_endpoint_validation():
    for address in ('http://remote.example/v1','https://user:password@example.com/v1','https://example.com/v1?key=secret'):
        with pytest.raises(ValueError):
            config.Settings(llm_base_url=address)
    assert config.Settings(llm_base_url='http://localhost:11434/v1').llm_base_url


def test_api_upload_import_download_security(workspace,pdf_bytes,record):
    with TestClient(app,base_url='http://127.0.0.1') as client:
        assert client.get('/').status_code==200
        assert client.post('/api/settings',json={}).status_code==403
        headers={'x-archive-request':'1'}
        assert client.post('/api/settings',json={},headers={**headers,'origin':'https://evil.example'}).status_code==403
        result=client.post('/api/archives',files={'file':('manual.pdf',pdf_bytes,'application/pdf')},headers=headers)
        assert result.status_code==200
        item_id=result.json()['id']
        assert client.get('/api/archives/'+item_id).json()['extraction']['page_count']==2
        imported=client.post('/api/archives/'+item_id+'/record',json=record,headers=headers)
        assert imported.status_code==200
        assert client.get('/api/archives/'+item_id+'/files/details.md').status_code==200
        assert client.get('/api/archives/'+item_id+'/files/processing.lock').status_code==404
        assert client.get('/api/archives/'+item_id+'/files/../../settings.json').status_code!=200
        pack=client.get('/api/archives/'+item_id+'/analysis-pack')
        with zipfile.ZipFile(io.BytesIO(pack.content)) as bundle:
            assert 'manual.pdf' in bundle.namelist()
            assert 'pages/0002.png' in bundle.namelist()
            assert '分析说明.md' in bundle.namelist()
        saved=client.post('/api/settings',json={'llm_api_key':'secret-test','feishu_app_secret':'secret-test2'},headers=headers)
        assert saved.status_code==200 and 'secret-test' not in saved.text
        client.post('/api/settings',json={'llm_api_key':''},headers=headers)
        assert config.get_settings().llm_api_key=='secret-test'
        assert client.get('/api/health',headers={'host':'evil.example'}).status_code==400


def test_visual_batches_cover_all_pages_and_resume(workspace,pdf_bytes,record,monkeypatch):
    item=workflow.ingest(pdf_bytes,'manual.pdf');workflow.process(item['id'])
    folder=store.folder(item['id']);ex=json.loads((folder/'extraction.json').read_text('utf-8'))
    model=VisionModel(config.Settings(llm_base_url='http://localhost:11434/v1',llm_model='test',pages_per_batch=1))
    calls=[]
    def complete(messages,**kwargs):
        calls.append(messages)
        if 'page_notes' in messages[-1]['content'][0]['text']:
            return json.dumps(record)
        return json.dumps({'facts':['fact'],'interface_candidates':[],'warnings':[]})
    monkeypatch.setattr(model,'complete',complete)
    model.archive(ex,folder)
    assert len(calls)==3
    assert all(any(c['type']=='image_url' for c in call[1]['content']) for call in calls[:2])
    calls.clear();model.archive(ex,folder)
    assert len(calls)==1


def test_interrupted_processing_and_sync_recover_on_start(workspace,pdf_bytes):
    item=workflow.ingest(pdf_bytes,'manual.pdf')
    store.update(item['id'],status='analyzing',sync={'status':'syncing','detail_id':'preserved'})
    store.initialize()
    result=store.get(item['id'])
    assert result['status']=='interrupted'
    assert result['sync']['status']=='failed'
    assert result['sync']['detail_id']=='preserved'


def test_parallel_duplicate_upload_is_single_intact_archive(workspace,pdf_bytes):
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=4) as pool:
        results=list(pool.map(lambda _:workflow.ingest(pdf_bytes,'manual.pdf'),range(8)))
    assert len({r['id'] for r in results})==1
    assert len(store.all_items())==1
    assert (store.folder(results[0]['id'])/'manual.pdf').read_bytes()==pdf_bytes


def test_manual_analysis_uses_knowledge_without_other_plugin_claims(workspace,pdf_bytes,record,monkeypatch):
    item=workflow.ingest(pdf_bytes,'manual.pdf');workflow.process(item['id']);workflow.import_record(item['id'],record)
    kb=workspace/'knowledge';kb.mkdir()
    (kb/'terms.md').write_text('Chorus 是合唱效果，Stereo 为立体声。','utf-8')
    hits=retrieve('Chorus Stereo',kinds={'knowledge'})
    assert hits and all(h['kind']=='knowledge' for h in hits)
    folder=store.folder(item['id']);ex=json.loads((folder/'extraction.json').read_text('utf-8'))
    model=VisionModel(config.Settings(llm_base_url='http://localhost:11434/v1',llm_model='test'))
    calls=[]
    def complete(messages,**kwargs):
        calls.append(messages)
        if 'page_notes' in messages[-1]['content'][0]['text']:
            return json.dumps(record)
        return json.dumps({'facts':[],'interface_candidates':[],'warnings':[]})
    monkeypatch.setattr(model,'complete',complete)
    model.archive(ex,folder)
    assert 'Chorus 是合唱效果' in calls[0][0]['content']
    assert '使用可变延迟产生合唱效果' not in calls[0][0]['content']
