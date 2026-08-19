---
description: 检查 ChatGPT OAuth 代理与登录态的健康状况
---

检查 kimi-codex-oauth 的运行状态并向用户汇报：

1. `curl -s http://127.0.0.1:8317/healthz` —— 看代理是否在运行、token 还有多久过期（`access_token_expires_in_s`)、`last_refresh` 时间。不通则先运行 `node "$KIMI_PLUGIN_ROOT/bin/ensure-proxy.mjs"` 启动代理再重试。
2. 若 `access_token_expires_in_s` 很小或为 null，发一个最小请求触发刷新并确认成功：
   `curl -sN -X POST http://127.0.0.1:8317/v1/responses -H 'content-type: application/json' -d '{"model":"gpt-5.6-luna","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"say ok"}]}]}' | head -c 400`
3. 若 `healthz` 显示 `has_tokens: false` 且带有 `hint`(API-key 登录），说明用户用的是 API key 而不是 ChatGPT 订阅登录：告诉用户本插件不适用，建议直接在 `~/.kimi-code/config.toml` 配一个标准 `openai_responses` provider（`api_key` 填 API key,`base_url` 用默认 `https://api.openai.com/v1`)，并询问是否要帮忙配置。若出现 401 且刷新也失败，说明登录态已失效：提醒用户重新运行 `codex login`（或删除 `~/.codex/auth.json` 后重登）。
4. 需要更多细节时查看日志尾部：`tail -20 ~/.codex/oauth-proxy.log`(Windows PowerShell 用 `Get-Content ~\.codex\oauth-proxy.log -Tail 20`)。

汇报：代理是否运行、token 剩余有效期、最近一次刷新时间、测试请求是否成功。
