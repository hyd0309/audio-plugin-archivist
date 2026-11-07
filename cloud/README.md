# 效果器档案室 · 在线版

用户自行配置模型和飞书，通过手册归档、飞书文档/多维表格、按创作需求选用，找回被遗忘的音频效果器。

在线入口为个人网站 `/ai/audio-archive/`，应用独立部署，后续发布不影响一级页面。

- 公开配置手册与虚构归档示意
- 托管 ChatGPT 登录，HMAC 身份标识，AES-GCM 加密配置
- 浏览器 PDF 阅读与分批视觉理解
- 飞书用户 OAuth、原生文档引用、可增项的多选表格
- 以飞书为唯一插件数据源，无平台插件库/历史回查

运行与架构见 [DEPLOYMENT.md](DEPLOYMENT.md)。入口组件在 `app/`，核心逻辑在 `lib/`，数据结构在 `db/schema.ts`。原 Python 本地工作台保留在上级工作区，未把本地用户数据迁入在线服务。

## 本地

Node.js 22.13+；`npm ci` 后 `npm run dev`。首次使用数据库时，按 Sites 的本地 D1 流程执行 `drizzle/0000_nifty_shiva.sql`。本地 `.dev.vars` 设置随机的 32 字节 Base64 `VAULT_KEY`，不得提交。

测试 `npm test`；类型检查 `npx tsc --noEmit`；构建 `npm run build`。
