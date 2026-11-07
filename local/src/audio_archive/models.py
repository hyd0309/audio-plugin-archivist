from typing import Literal
import re
from urllib.parse import urlparse
from pydantic import BaseModel, Field, ConfigDict, field_validator


class Evidence(BaseModel):
    page: int = Field(ge=1)
    claim: str = Field(min_length=1, max_length=1000)


class SourceEvidence(BaseModel):
    model_config = ConfigDict(extra='forbid')
    source: str = Field(min_length=1, max_length=80)
    page: int = Field(ge=1)
    quote: str = Field(min_length=8, max_length=1000)


class FilterTags(BaseModel):
    model_config = ConfigDict(extra='forbid')
    厂商: str = Field(default='', max_length=200)
    适用音源: list[str] = Field(default_factory=list, max_length=30)
    音源依据: list[SourceEvidence] = Field(default_factory=list, max_length=30)

    @field_validator('适用音源')
    @classmethod
    def short_options(cls, values):
        values=list(dict.fromkeys(v.strip() for v in values if v.strip()))
        if any(len(v)>80 for v in values):
            raise ValueError('筛选选项应是简短标签，每项最多 80 字')
        return values


class Archive(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra='forbid')
    name: str = Field(alias='名称', min_length=1, max_length=200)
    categories: list[str] = Field(alias='类属', min_length=1, max_length=20)
    scenarios: list[str] = Field(alias='风格场景', min_length=1, max_length=30)
    website: str = Field(default='', alias='官网链接', max_length=2000)
    description: str = Field(alias='详细说明', min_length=20, max_length=100000)
    image_id: str | None = Field(default=None, alias='界面图')
    evidence: list[Evidence] = Field(default_factory=list)
    caveats: list[str] = Field(default_factory=list)
    filter_tags: FilterTags | None = Field(default=None, alias='筛选标签')

    def archive_dict(self):
        return self.model_dump(by_alias=True, exclude={'filter_tags'} if self.filter_tags is None else set())

    @field_validator('name', mode='before')
    @classmethod
    def normalize_display_name(cls, value):
        if isinstance(value, str):
            return re.sub(r'(?:\s*[(（]\s*(?:stereo|mono|立体声|单声道)\s*(?:手册|manual)?\s*[)）])+\s*$', '', value, flags=re.I).strip()
        return value

    @field_validator('name', 'description')
    @classmethod
    def nonblank(cls, value):
        if not value.strip():
            raise ValueError('内容不能为空')
        return value.strip()

    @field_validator('categories', 'scenarios')
    @classmethod
    def tags(cls, values):
        tags = list(dict.fromkeys(v.strip() for v in values if v.strip()))
        if not tags or any(len(v) > 200 for v in tags):
            raise ValueError('标签不能为空且单个标签不可超过 200 字')
        return tags

    @field_validator('website')
    @classmethod
    def safe_url(cls, value):
        if not value:
            return value
        u = urlparse(value)
        if u.scheme not in {'http', 'https'} or not u.hostname or u.username or u.password:
            raise ValueError('官网链接须为有效 HTTP(S) 地址，未知时留空')
        return value


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=10000)
    history: list[dict[str, str]] = Field(default_factory=list, max_length=20)
