---
description: 配置 Kimi Code 复用本机 ChatGPT(Codex) OAuth 登录 —— 启动本地代理并写入 config.toml
---

把 Kimi Code 接入本机 ChatGPT OAuth 登录态。按以下步骤执行，全部基于事实验证，不要跳过检查：

1. 检查前置条件（用 Bash，并行）：
   - `node --version` 必须 >= 18
   - `~/.codex/auth.json` 存在且 `tokens.access_token` / `tokens.refresh_token` 非空（用 python3 或 jq 检查字段是否存在，不要把 token 内容打印出来）
2. 启动代理：运行 `node "$KIMI_PLUGIN_ROOT/bin/ensure-proxy.mjs"`（若该环境变量不存在，用 `/plugins info kimi-codex-oauth` 显示的插件目录下的 `bin/ensure-proxy.mjs`)，然后 `curl -s http://127.0.0.1:8317/healthz` 确认 `ok: true`。
3. 检查 `~/.kimi-code/config.toml` 中是否已存在 `[providers.chatgpt-oauth]`。若不存在，追加以下配置（已存在则跳过对应段落）：

```toml
[providers.chatgpt-oauth]
type = "openai_responses"
base_url = "http://127.0.0.1:8317/v1"
api_key = "local-proxy"

[models."chatgpt/gpt-5.6-luna"]
provider = "chatgpt-oauth"
model = "gpt-5.6-luna"
max_context_size = 400000
capabilities = ["thinking", "tool_use", "image_in"]

[models."chatgpt/gpt-5.6-sol"]
provider = "chatgpt-oauth"
model = "gpt-5.6-sol"
max_context_size = 400000
capabilities = ["thinking", "tool_use", "image_in"]
```

（该账号当前可用的上游模型以 `curl -s http://127.0.0.1:8317/v1/models` 为准；`gpt-5.6-luna` 消耗较低，适合日常使用。）

4. 端到端验证：运行 `kimi -m chatgpt/gpt-5.6-luna -p "只回复 ok 两个字母"`(注意 `-m` 必须在 `-p` 之前，否则 `-p` 会把 `-m` 吞成提示词）,确认能正常返回。失败时查看 `~/.codex/oauth-proxy.log`。
5. 向用户报告结果：代理状态、写入了哪些配置、验证是否通过。提醒用户用 `/model` 切换到 `chatgpt/gpt-5.6-luna`。
