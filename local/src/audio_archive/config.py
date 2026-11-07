from pathlib import Path
from urllib.parse import urlparse
import json
import os
from pydantic import BaseModel, Field, field_validator
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[2]
DATA = Path(os.environ.get('AUDIO_ARCHIVE_DATA', ROOT / 'data')).resolve()
load_dotenv(ROOT / '.env')


class Settings(BaseModel):
    llm_base_url: str = ''
    llm_model: str = ''
    llm_api_key: str = ''
    pages_per_batch: int = Field(default=4, ge=1, le=10)
    max_pdf_pages: int = Field(default=300, ge=1, le=2000)
    feishu_app_id: str = ''
    feishu_app_secret: str = ''
    feishu_folder_token: str = ''
    feishu_summary_id: str = ''
    feishu_redirect_uri: str = 'http://127.0.0.1:8765/api/feishu/callback'
    feishu_scopes: str = 'docx:document drive:drive offline_access'
    auto_sync: bool = False
    bitable_app_token: str = ''
    bitable_table_id: str = ''
    bitable_url: str = ''
    bitable_auto_sync: bool = False
    # Native document mention is always supported. Preview must be enabled explicitly
    # only after confirming that the tenant's OpenAPI supports that block.
    feishu_reference_mode: str = 'mention'

    @field_validator('llm_base_url')
    @classmethod
    def valid_endpoint(cls, value):
        if not value:
            return value
        u = urlparse(value)
        if u.username or u.password or u.query or u.fragment:
            raise ValueError('模型地址不能包含密码、查询参数或锚点')
        if u.scheme != 'https' and not (u.scheme == 'http' and u.hostname in {'localhost', '127.0.0.1', '::1'}):
            raise ValueError('远程模型使用 HTTPS；本机模型可使用 HTTP')
        return value.rstrip('/')

    @field_validator('feishu_reference_mode')
    @classmethod
    def reference_mode(cls, value):
        if value not in {'mention', 'preview'}:
            raise ValueError('引用模式必须为 mention 或 preview')
        return value

    @property
    def model_ready(self):
        return bool(self.llm_base_url and self.llm_model)

    @property
    def feishu_ready(self):
        return bool(self.feishu_app_id and self.feishu_app_secret and self.feishu_summary_id and self.feishu_folder_token)


def get_settings() -> Settings:
    path = DATA / 'settings.json'
    values = json.loads(path.read_text('utf-8')) if path.exists() else {}
    for key in Settings.model_fields:
        env = os.getenv(key.upper())
        if env is not None:
            values[key] = env
    return Settings.model_validate(values)


def save_settings(values: dict):
    from .store import atomic_json
    current = get_settings().model_dump()
    # Empty secret fields preserve credentials; secrets never return to browser.
    for key, value in values.items():
        if key not in Settings.model_fields:
            continue
        if key in {'llm_api_key', 'feishu_app_secret'} and not value:
            continue
        current[key] = value
    settings = Settings.model_validate(current)
    atomic_json(DATA / 'settings.json', settings.model_dump())
    return settings


def public_settings():
    settings = get_settings()
    result = settings.model_dump(exclude={'llm_api_key', 'feishu_app_secret'})
    result.update(model_ready=settings.model_ready, feishu_ready=settings.feishu_ready,
                  has_llm_api_key=bool(settings.llm_api_key), has_feishu_app_secret=bool(settings.feishu_app_secret))
    return result
