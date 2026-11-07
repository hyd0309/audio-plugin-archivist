from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
import json
import os
import sqlite3
import uuid
from .config import DATA


def now():
    return datetime.now(timezone.utc).isoformat()


def atomic_json(path: Path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + '.' + uuid.uuid4().hex + '.pending')
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    os.replace(temp, path)


@contextmanager
def db():
    DATA.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DATA / 'archive.sqlite3', timeout=30)
    connection.row_factory = sqlite3.Row
    try:
        yield connection
        connection.commit()
    finally:
        connection.close()


def initialize():
    with db() as c:
        c.execute('PRAGMA journal_mode=WAL')
        c.execute('''CREATE TABLE IF NOT EXISTS archives (
          id TEXT PRIMARY KEY, filename TEXT NOT NULL, status TEXT NOT NULL,
          progress TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          record TEXT, error TEXT NOT NULL DEFAULT '', sync TEXT NOT NULL DEFAULT '{}')''')
        # A process interruption is recoverable and must not look as if still running.
        c.execute("UPDATE archives SET status='interrupted', progress='上次处理被中断，可重新分析' WHERE status IN ('extracting','analyzing','queued')")
        for row in c.execute('SELECT id,sync FROM archives').fetchall():
            sync = json.loads(row['sync'] or '{}')
            if sync.get('bitable',{}).get('status')=='syncing':
                sync['bitable'].update(status='failed',error='上次表格同步被中断，可核对后重试')
                c.execute('UPDATE archives SET sync=? WHERE id=?',(json.dumps(sync,ensure_ascii=False),row['id']))
            if sync.get('status') == 'syncing':
                sync.update(status='failed', error='上次同步被中断。重试会读取步骤记录；不确定的写入会暂停并提示核对。')
                c.execute('UPDATE archives SET sync=? WHERE id=?', (json.dumps(sync,ensure_ascii=False), row['id']))


def folder(item_id: str) -> Path:
    if len(item_id) != 64 or any(ch not in '0123456789abcdef' for ch in item_id):
        raise ValueError('无效档案编号')
    return DATA / 'archives' / item_id


def get(item_id):
    with db() as c:
        row = c.execute('SELECT * FROM archives WHERE id=?', (item_id,)).fetchone()
    if row is None:
        raise KeyError('未找到档案')
    result = dict(row)
    for key in ('record', 'sync'):
        result[key] = json.loads(result[key]) if result[key] else None
    return result


def all_items():
    with db() as c:
        ids = [r['id'] for r in c.execute('SELECT id FROM archives ORDER BY created_at DESC')]
    return [get(item_id) for item_id in ids]


def create(item_id, filename):
    with db() as c:
        c.execute('INSERT OR IGNORE INTO archives(id,filename,status,progress,created_at,updated_at) VALUES(?,?,?,?,?,?)',
                  (item_id, filename, 'queued', '等待读取 PDF', now(), now()))
    return get(item_id)


def update(item_id, **values):
    if not set(values) <= {'status', 'progress', 'record', 'error', 'sync'}:
        raise ValueError('无效更新字段')
    values['updated_at'] = now()
    for key in ('record', 'sync'):
        if key in values:
            values[key] = json.dumps(values[key], ensure_ascii=False)
    with db() as c:
        c.execute('UPDATE archives SET '+ ','.join(f'{key}=?' for key in values) +' WHERE id=?', (*values.values(), item_id))


def save_record(item_id, record):
    target = folder(item_id)
    # Immutable versions preserve manual edits and previous model outputs.
    version = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%f')
    atomic_json(target / 'versions' / f'{version}.json', record)
    atomic_json(target / 'record.json', record)
    description = record['详细说明']
    text = f"# {record['名称']}\n\n类属：{' / '.join(record['类属'])}\n\n风格场景：{' / '.join(record['风格场景'])}\n\n官网：{record['官网链接'] or '手册未说明'}\n\n{description}\n"
    (target / 'details.md').write_text(text, encoding='utf-8')
    update(item_id, record=record, status='archived', progress='已保存至本地档案', error='')
