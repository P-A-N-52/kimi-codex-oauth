---
name: using-codex-oauth
description: 在 Kimi Code 中复用本机 ChatGPT(Codex CLI) OAuth 登录使用 GPT 模型的使用说明与排障。当用户询问 chatgpt/gpt-5 模型、codex-oauth 代理、或相关报错时使用。
---

# using-codex-oauth

本插件通过本地代理(`127.0.0.1:8317`，零依赖 Node 脚本）复用 `~/.codex/auth.json` 中的 ChatGPT OAuth 登录态，把 Kimi Code 的 OpenAI Responses 请求转发到 ChatGPT 后端。代理自动刷新 access token 并注入所需请求头。

## 使用

- 首次配置：运行 `/kimi-codex-oauth:setup`。
- 切换模型:`/model` 选择 `chatgpt/gpt-5.6-luna`（省额度）或 `chatgpt/gpt-5.6-sol`，或启动时 `kimi -m chatgpt/gpt-5.6-luna`。
- 健康检查:`/kimi-codex-oauth:status`。
- 代理随会话自动启动（SessionStart hook)；也可手动：`node <插件目录>/bin/ensure-proxy.mjs`。

## 排障

- 401 且自动刷新失败 → 登录态失效，重新 `codex login`。
- 连接被拒 → 代理没起，运行 status 命令或手动 ensure-proxy。
- 上游报错细节 → `tail -50 ~/.codex/oauth-proxy.log`。
- 端口冲突 → 设 `CODEX_OAUTH_PORT` 并同步修改 config.toml 里 provider 的 `base_url`。

## 注意

复用 ChatGPT 订阅登录态供第三方客户端使用属于 OpenAI 服务条款的灰色地带，账号风险自负。token 只经本机 localhost 转发，不会发送到其他服务器。
