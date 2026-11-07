from pathlib import Path
import uuid
import pytest
import pymupdf
from audio_archive import config, store, feishu, search, api


@pytest.fixture
def workspace(monkeypatch):
    # Keep test outputs: user explicitly requested no file deletion.
    path=config.ROOT/'data'/'test-runs'/uuid.uuid4().hex
    path.mkdir(parents=True)
    for module in (config,store,feishu,search,api):
        monkeypatch.setattr(module,'DATA',path)
    for key in config.Settings.model_fields:
        monkeypatch.delenv(key.upper(),raising=False)
    store.initialize()
    return path


@pytest.fixture
def pdf_bytes():
    doc=pymupdf.open()
    for text in ('Test Chorus Manual','Delay Rate Depth Stereo Spread'):
        page=doc.new_page()
        page.insert_text((70,70),text)
    data=doc.tobytes()
    doc.close()
    return data


@pytest.fixture
def record():
    return {'名称':'Test Chorus','类属':['合唱（Chorus）'],'风格场景':['电吉他立体声展宽','复古合唱'],
            '官网链接':'https://example.com/chorus','详细说明':'## 插件定位\n使用可变延迟产生合唱效果，应用建议需要根据音源调整。',
            '界面图':None,'evidence':[{'page':1,'claim':'手册名称为 Test Chorus'}],'caveats':[]}
