# 独立应用接入

`/ai/audio-archive/` 由此网关直接代理独立效果器服务，浏览器地址仍是个人网站路径。主站托管登录确认用户后，网关以短时 HMAC 签名传递身份和原始请求摘要。应用只信任签名通过的请求，不信任访客自填身份头。密钥不在仓库中。

一级页面继续使用 `dist/` 原有静态文件，构建时字节原样嵌入 Worker。`dist/ai/audio-archive/` 原介绍页保留为历史文件，但请求被网关路由接管。

## 后续发布
- **更新 agent**：只发布独立应用项目；保持运行地址与共享网关密钥，主页不需要重新发布。
- **更新主页**：以最新云端源为基线，只改主页静态文件，保留 gateway 和 Worker hosting 配置；执行 `node gateway/build.mjs` 后发布。不要恢复旧版 static hosting 配置，否则应用路由会退回介绍页。
- 主站运行变量 `AUDIO_APP_ORIGIN` 为独立应用的固定 HTTPS 地址，`GATEWAY_KEY` 为私有共享密钥。独立应用使用相同 `GATEWAY_KEY` 与 `PUBLIC_ORIGIN=https://huangyd.is-a.dev`。
- 发布前对比 `gateway/static-hashes.json`，二级页面变更不应改变一级页面内容摘要。
- 回滚网关可部署之前的静态站点版本，首页保留，二级入口退回介绍页。应用可单独回滚。
