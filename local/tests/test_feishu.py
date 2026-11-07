import json
import time
from pathlib import Path
from urllib.parse import parse_qs,urlparse
import httpx
import pytest
from audio_archive.config import Settings
from audio_archive.feishu import Feishu,FeishuError,UncertainWrite,SyncJournal,sync_archive,resource_id,reference_block
from audio_archive.store import atomic_json


def settings():
    return Settings(feishu_app_id='cli_test',feishu_app_secret='test-secret',feishu_folder_token='folder1',feishu_summary_id='summary1')


def test_oauth_state_and_refresh(workspace):
    requests=[]
    def handler(request):
        requests.append(json.loads(request.content))
        return httpx.Response(200,json={'code':0,'access_token':'test-token','refresh_token':'refresh-test','expires_in':7200})
    fs=Feishu(settings(),httpx.MockTransport(handler))
    state=parse_qs(urlparse(fs.auth_url()).query)['state'][0]
    with pytest.raises(FeishuError):fs.exchange('code','wrong')
    assert requests==[]
    fs.exchange('code',state)
    assert fs.token()=='test-token'
    with pytest.raises(FeishuError):fs.exchange('code',state)
    saved=json.loads(fs.token_path.read_text('utf-8'));saved['expires_at']=0;atomic_json(fs.token_path,saved)
    assert fs.token()=='test-token'
    assert requests[-1]['grant_type']=='refresh_token'


def test_ambiguous_journal_does_not_repeat(workspace):
    journal=SyncJournal(workspace/'journal.json');count=[]
    def fail(_):count.append(1);raise UncertainWrite('unknown')
    with pytest.raises(UncertainWrite):journal.step('create_detail',fail)
    with pytest.raises(UncertainWrite):SyncJournal(journal.path).step('create_detail',fail)
    assert len(count)==1


def test_rejected_journal_can_resume(workspace):
    journal=SyncJournal(workspace/'journal.json')
    with pytest.raises(FeishuError):journal.step('append',lambda _:(_ for _ in ()).throw(FeishuError('permission')))
    assert journal.step('append',lambda _:{'ok':True})=={'ok':True}
    assert journal.step('append',lambda _:pytest.fail('repeated'))=={'ok':True}


def test_full_sync_native_blocks_idempotent_and_no_delete(workspace,record):
    writes=[]
    def handler(request):
        if request.method=='GET':
            return httpx.Response(200,json={'code':0,'data':{'document':{'title':record['名称']},'content':record['名称']}})
        writes.append(request)
        path=request.url.path
        if path.endswith('/documents'):data={'document':{'document_id':'detail1'}}
        elif path.endswith('/children'):data={'children':[{'block_id':'imageblock'}]}
        elif path.endswith('/upload_all'):data={'file_token':'image-token'}
        else:data={}
        return httpx.Response(200,json={'code':0,'data':data})
    fs=Feishu(settings(),httpx.MockTransport(handler))
    atomic_json(fs.token_path,{'client_id':'cli_test','access_token':'token','expires_at':time.time()+7200})
    folder=workspace/'item';folder.mkdir();(folder/'img.png').write_bytes(b'test image')
    record={**record,'界面图':'img1'}
    extraction={'images':[{'id':'img1','path':'img.png'}]}
    configured=settings().model_copy(update={'feishu_summary_id':'https://workspace.feishu.cn/docx/summary1'})
    result=sync_archive(configured,record,extraction,folder,client=fs)
    assert result['status']=='synced'
    assert result['detail_url']=='https://workspace.feishu.cn/docx/detail1'
    assert result['summary_url']=='https://workspace.feishu.cn/docx/summary1'
    first_count=len(writes)
    sync_archive(configured,record,extraction,folder,client=fs)
    assert len(writes)==first_count
    assert all(r.method!='DELETE' for r in writes)
    blocks=[json.loads(r.content) for r in writes if r.url.path.endswith('/children')]
    assert any(b['children'][0].get('image')=={} for b in blocks)
    assert blocks[-1]['children'][0]['text']['elements'][0]['mention_doc']['token']=='detail1'
    upload=next(r for r in writes if r.url.path.endswith('upload_all'))
    assert b'parent_node' in upload.content and b'imageblock' in upload.content
    assert sum(r.url.path.endswith('/documents') for r in writes)==1


def test_resource_id_and_native_reference():
    assert resource_id('https://example.feishu.cn/docx/abcdef','docx')=='abcdef'
    assert resource_id('https://example.feishu.cn/drive/folder/folder123','folder')=='folder123'
    with pytest.raises(ValueError):resource_id('https://evil.example/docx/abcdef','docx')
    with pytest.raises(ValueError):resource_id('https://example.feishu.cn/wiki/abcdef','docx')
    assert reference_block('abcdef','title')['text']['elements'][0]['mention_doc']['obj_type']==22
