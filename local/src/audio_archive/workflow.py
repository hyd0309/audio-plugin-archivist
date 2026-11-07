from pathlib import Path
import hashlib
import json
from filelock import FileLock, Timeout
from . import store
from .config import get_settings
from .pdf import extract_pdf
from .llm import VisionModel, validate_record
from .models import Archive
from .feishu import sync_archive


def ingest(raw: bytes,filename: str):
    if len(raw)>100*1024*1024:
        raise ValueError('PDF 最大支持 100 MB')
    if not raw.startswith(b'%PDF-'):
        raise ValueError('文件不是有效 PDF')
    item_id=hashlib.sha256(raw).hexdigest()
    target=store.folder(item_id)
    target.mkdir(parents=True,exist_ok=True)
    source=target/'manual.pdf'
    with FileLock(str(target/'ingest.lock')):
        if not source.exists():
            import os
            import uuid
            pending=target/('upload-'+uuid.uuid4().hex+'.pending')
            pending.write_bytes(raw)
            os.replace(pending,source)
        item=store.create(item_id,Path(filename.replace('\\','/')).name)
    return item


def process(item_id):
    target=store.folder(item_id)
    try:
        with FileLock(str(target/'processing.lock')):
            try:
                settings=get_settings()
                progress=lambda message:store.update(item_id,progress=message)
                path=target/'extraction.json'
                if path.exists():
                    extraction=json.loads(path.read_text('utf-8'))
                else:
                    store.update(item_id,status='extracting',error='')
                    # PyMuPDF must not be used by concurrent worker threads.
                    with FileLock(str(store.DATA/'pdf-extraction.lock')):
                        extraction=extract_pdf(target/'manual.pdf',target,settings.max_pdf_pages,progress)
                if not settings.model_ready:
                    store.update(item_id,status='awaiting_model',progress='PDF 已读取，可导出分析包交给当前对话，或配置模型后继续',error='')
                    return
                store.update(item_id,status='analyzing',error='')
                record=VisionModel(settings).archive(extraction,target,progress)
                store.save_record(item_id,record.archive_dict())
            except Exception as error:
                store.update(item_id,status='failed',error=safe_error(error),progress='处理未完成；已有结果均保留，可重试')
                return
        if settings.auto_sync:
            sync(item_id)
        if settings.bitable_auto_sync:
            sync_table(item_id)
    except Timeout:
        return


def import_record(item_id,value):
    target=store.folder(item_id)
    with FileLock(str(target/'processing.lock'),timeout=0):
        extraction=json.loads((target/'extraction.json').read_text('utf-8'))
        record=Archive.model_validate(value)
        validate_record(record,extraction)
        store.save_record(item_id,record.archive_dict())
    return store.get(item_id)


def sync(item_id):
    target=store.folder(item_id)
    try:
        with FileLock(str(target/'processing.lock')):
            item=store.get(item_id)
            if not item['record']:
                raise ValueError('请先完成或导入归档')
            try:
                store.update(item_id,sync={**item['sync'],'status':'syncing','error':''})
                extraction=json.loads((target/'extraction.json').read_text('utf-8'))
                # Keep the fields, image and reference of each summary entry together.
                with FileLock(str(store.DATA/'feishu-sync.lock')):
                    result=sync_archive(get_settings(),item['record'],extraction,target,
                        lambda message:store.update(item_id,progress=message),previous=item['sync'])
                store.update(item_id,sync={**item['sync'],**result},progress='本地与飞书归档完成')
            except Exception as error:
                store.update(item_id,sync={**item['sync'],'status':'failed','error':safe_error(error)},progress='本地档案已保存，飞书同步未完成')
    except Timeout:
        return


def sync_table(item_id):
    from .bitable import sync_item
    with FileLock(str(store.folder(item_id)/'processing.lock')):
        item=store.get(item_id)
        previous=item['sync'] or {}
        store.update(item_id,sync={**previous,'bitable':{**previous.get('bitable',{}),'status':'syncing','error':''}})
        try:
            with FileLock(str(store.DATA/'bitable.lock')):
                result=sync_item(item,get_settings())
            store.update(item_id,sync={**previous,'bitable':result},progress='多维表格归档完成')
        except Exception as error:
            store.update(item_id,sync={**previous,'bitable':{**previous.get('bitable',{}),'status':'failed','error':safe_error(error)}},progress='多维表格同步未完成；本地档案已保留')


def safe_error(error):
    from .llm import ModelError
    from .feishu import FeishuError
    if isinstance(error,(ValueError,ModelError,FeishuError)):
        return str(error)[:1500]
    return f'处理遇到 {type(error).__name__}，请检查输入与本地运行日志；文件已保留'
