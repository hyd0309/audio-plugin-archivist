# 本地版本

此目录保留本地 FastAPI 应用源码。先用 environment.yml 创建独立 conda 环境，再安装本目录并运行 audio-archive。默认监听 127.0.0.1:8765。Windows 的 start.cmd 可自动启动；其他机器需调整 scripts/start.ps1 中环境路径。

在线生产服务使用 ../cloud，不向互联网开放此本地服务。本地版会持久保存手册与档案于 data/，在线版不保存插件数据。

飞书配置说明见 docs/feishu-setup.md。系统提示词位于 prompts/。仓库不含凭证、个人档案或原始手册。
