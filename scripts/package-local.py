"""Build a distributable from an explicit source allowlist; never include user data."""
from pathlib import Path
import zipfile

repo = Path(__file__).resolve().parents[1]
root = repo / 'local' if (repo / 'local/pyproject.toml').is_file() else repo
target = repo / 'cloud/public/downloads/audio-plugin-archivist-local.zip'
files = [root / 'pyproject.toml']
for folder, pattern in [('src/audio_archive', '*.py'), ('prompts', '*.md'), ('web', '*')]:
    files.extend(p for p in (root / folder).glob(pattern) if p.is_file())
extras = {
    'install.cmd': '@echo off\r\ncd /d "%~dp0"\r\ncall conda create -n audio-plugin-archivist python=3.12 pip -y\r\nif errorlevel 1 goto fail\r\ncall conda run -n audio-plugin-archivist python -m pip install -e .\r\nif errorlevel 1 goto fail\r\necho Installation complete. Run start.cmd\r\npause\r\nexit /b 0\r\n:fail\r\necho Installation failed. Run from Miniconda Prompt and check the message above.\r\npause\r\nexit /b 1\r\n',
    'start.cmd': '@echo off\r\ncd /d "%~dp0"\r\ncall conda run --no-capture-output -n audio-plugin-archivist python -m audio_archive serve --open\r\nif errorlevel 1 pause\r\n',
    'README.md': '''# 音频效果器归档助手 · 本地版

适用于 Windows，需要联网安装依赖。程序包不附带 API、密钥或任何用户档案。

1. 安装 Miniconda：https://www.anaconda.com/docs/getting-started/miniconda/install
2. 完整解压 ZIP。在开始菜单打开 Miniconda Prompt，输入 `cd /d "解压目录"`。
3. 运行 `install.cmd`，等待独立 Conda 环境和依赖安装完成。只需安装一次；已有同名环境时不要覆盖，可直接运行 `conda run -n audio-plugin-archivist python -m pip install -e .`。
4. 在同一窗口运行 `start.cmd`，打开 http://127.0.0.1:8765 。保留运行窗口，按 Ctrl+C 停止。
5. 设置中填写支持图片输入的模型 API Base URL、模型名称和 API Key（从模型服务商控制台创建）。
6. 在飞书开放平台 https://open.feishu.cn/app 创建企业自建应用，从凭证页获取 App ID 和 App Secret。开通用户身份权限 docx:document、drive:drive、bitable:app、offline_access，并发布权限变更。
7. 应用安全设置的重定向 URL 填 `http://127.0.0.1:8765/api/feishu/callback`。在本地设置填写目标文件夹、汇总文档链接或 ID，保存后点击飞书授权。需要多维表格时再授权并配置表格。
8. 上传自己的 Manual PDF，检查解析内容与配图后归档到飞书。

配置、授权凭证和本地档案在 `data/` 中保存。不要把该目录分享或上传到公开代码库。网站上的配置不会随安装包带入。API 调用费用由用户自行承担。

如端口 8765 被占用，先关闭旧工作台再启动。安装失败请检查网络与 Miniconda；不要反复创建或覆盖已有环境。
'''
}
target.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as archive:
    for path in sorted(files):
        archive.write(path, 'audio-plugin-archivist/' + path.relative_to(root).as_posix())
    for name, content in extras.items():
        archive.writestr('audio-plugin-archivist/' + name, content)
with zipfile.ZipFile(target) as archive:
    assert archive.testzip() is None
    assert not any('/data/' in name or '/.env' in name or '__pycache__' in name for name in archive.namelist())
print(f'Packaged {len(files) + len(extras)} files: {target.stat().st_size} bytes')
