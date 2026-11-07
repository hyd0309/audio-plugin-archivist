# 发布与维护

## 独立入口
公开入口固定为 `https://huangyd.is-a.dev/ai/audio-archive/`。个人主页 Worker 只转发此路径；其他静态文件原样返回。归档应用单独部署到 Sites 项目 `appgprj_6aee24598bbc8191b9c8c4fba8a0614e`。以后只更新此项目，不重新发布个人主页。

个人主页网关签名原始 URL、请求方法、正文摘要、来源和托管登录的用户标识。归档 Worker 验证 30 秒时效的签名，再建立请求身份；拒绝未签名直连及伪造身份头。双方共享 `GATEWAY_KEY`，独立应用另有 `VAULT_KEY` 与 `PUBLIC_ORIGIN`，值只存平台运行环境，不提交源码。

## 数据结构
- accounts：owner（带密钥的 HMAC 标识）、vault（AES-256-GCM 配置密文，AAD 绑定 owner）、updated。
- oauth：一次性 state 摘要、owner、浏览器与应用绑定摘要、10 分钟有效期；回调原子消费。
- guards：用户隔离的原子并发锁、分钟操作计数、每日模型调用计数。锁异常时最长 20 分钟后释放。清除配置后限流记录仍保留，防止绕过额度。
- 没有插件、手册、聊天或检索数据表；没有对象存储绑定。飞书为档案唯一持久数据源。密钥不是哈希，因调用服务时必须临时解密。

## 校验
`npm ci`，`npm test`，`npx tsc --noEmit`，`npm run build`。
`tests/production-http.mjs` 仅针对本机生成的 Worker 与测试密钥运行，检查真实路由隔离，不发送第三方请求。`scripts/preview-gateway.mjs` 的模拟登录仅绑定 127.0.0.1，不参与生产导入。

## 限制与运维
- 使用用户自己的支持视觉和 JSON 输出的 Chat Completions API，服务商固定为 OpenAI、百炼中国内地、硅基流动。未配置真实 Key 时不能声称计费模型调用已联调。
- 原始 PDF 浏览器处理，最多 25 MB / 80 页。每 4 页一批模型请求，结果不跨刷新保存。
- 同名厂商/插件在飞书去重。对于新建文档响应不确定的情况，停止自动重试，飞书“归档进度”保留待核对步骤。已完成记录不自动覆盖，个人备注保留。跨账号同时写同一个共享表格不属于推荐用法；每位用户应配置自己的归档位置。
- 飞书 OAuth 回调为 `https://huangyd.is-a.dev/ai/audio-archive/api/feishu/callback`，需由每个应用的管理员在飞书后台登记。所有网站写入请求校验同源；飞书 OAuth 回调是校验 state 的例外 GET。
- 选用最多读取 2000 条表格记录，选最多 10 份详情，正文上下文总计不超过 60000 字符。检索为轻量关键词匹配，不宣称遍历理解全部收藏。
- 不记录正文或密钥到应用日志。托管商仍可能保留访问日志；不能宣称互联网处理过程完全不留元数据。OAuth code 不主动记录。
- `VAULT_KEY` 不能直接替换，否则旧配置不可解密；轮换需要旧密钥支持的重加密迁移。网关密钥轮换需协调两个站点。
- GitHub 与 Sites 源码仓库分别同步，二者提交号不同；上传脚本必须只纳入审查过的源码，禁止 data、.env、.dev.vars、临时部署产物和个人手册。

## 核验依据
- https://developers.openai.com/api/reference/resources/chat
- https://help.aliyun.com/zh/model-studio/qwen-structured-output
- https://open.feishu.cn/document/authentication-management/access-token/refresh-user-access-token
- https://open.feishu.cn/document/server-docs/docs/bitable-v1/app-table-record/create
- https://mozilla.github.io/pdf.js/getting_started/
