# kimi-codex-oauth

让 Kimi Code 复用电脑上 ChatGPT(Codex CLI）的 OAuth 登录态，直接在 Kimi Code 中使用 GPT 模型（gpt-5.6-luna / gpt-5.6-sol 等，可用列表以账号为准）。

## 原理

```
Kimi Code ──> http://127.0.0.1:8317/v1/responses (本地代理)
                 │  自动读取/刷新 ~/.codex/auth.json
                 │  注入 chatgpt-account-id 等必需请求头，规范化请求体
                 ▼
           https://chatgpt.com/backend-api/codex/responses
```

- 代理是零依赖的 Node(>=18）单文件脚本，只监听 `127.0.0.1`。
- access token 临近过期时自动用 refresh token 刷新并原子写回 `~/.codex/auth.json`（与 Codex CLI 共存安全：写前重读合并）。
- Kimi Code 侧通过 `config.toml` 里一个普通的 `openai_responses` provider 接入，无需任何补丁。

## 安装

前置条件：已安装 Codex CLI 并完成 `codex login`(ChatGPT 账号登录）,`~/.codex/auth.json` 存在；Node.js >= 18。macOS / Linux / Windows 均可。

在 Kimi Code 中：

```
/plugins install https://github.com/P-A-N-52/kimi-codex-oauth
/reload
/kimi-codex-oauth:setup
```

（本地目录也可以：`/plugins install /path/to/kimi-codex-oauth`。）

setup 命令会：检查环境 → 启动代理 → 向 `~/.kimi-code/config.toml` 写入 provider 与模型别名 → 端到端验证。

之后用 `/model` 切换到 `chatgpt/gpt-5.6-luna`，或 `kimi -m chatgpt/gpt-5.6-luna`。

## 日常命令

| 命令 | 作用 |
| --- | --- |
| `/kimi-codex-oauth:setup` | 一键配置（幂等，可重复运行） |
| `/kimi-codex-oauth:status` | 查看代理与 token 健康状态 |

代理由 SessionStart hook 自动拉起；每次新会话还会自动从上游拉取账号可用的模型列表并同步 `config.toml`：新模型按上游真实元数据（`context_window`、`input_modalities`、推理档位等）追加 `chatgpt/*` 别名，`default_effort` 创建时设为该模型支持的最高思考档（之后改不改随你，不会被纠回）；带 `# managed-by: kimi-codex-oauth` 标记的条目若被改坏（上下文长度、能力列表等）会被纠回上游值；去掉标记即视为用户自有条目，永不触碰，`[models."chatgpt/x".overrides]` 里的个人覆盖也永远保留。推理档位只使用线上协议真实接受的值（`low`~`max`；模型列表里的 `ultra` 是多智能体委托模式，不是 `reasoning.effort` 的合法取值，已实测确认并过滤）。没有变动时一个字节都不写；**每次写入前都会把候选配置放进沙箱跑 `kimi doctor` 校验，通不过就拒绝写入**——永远不会把 config.toml 写坏。上游拉取失败时完全跳过（绝不误删）。日志在 `~/.codex/oauth-proxy.log`。

模型生命周期自动处理：上游上架新模型（如 gpt-5.7）下次会话自动加别名；模型退役（从上游列表消失）时受管别名自动清理；登录方式切成 API key 时所有受管 `chatgpt/*` 别名自动清掉（切回 OAuth 会自动重建）。两条安全线：被 `default_model`/次级模型池引用的别名只警告不删除；没有 `# managed-by` 标记的用户自有条目永远不删。

另外：如果 `~/.codex/auth.json` 是 API key 登录（而非 ChatGPT 订阅 OAuth）且你从未用过本插件，`/kimi-codex-oauth:status` 会检测出来并提示你直接配标准 provider——那种情况不需要本插件。

## 卸载

```
/plugins remove kimi-codex-oauth
```

并手动删除 `~/.kimi-code/config.toml` 中的 `[providers.chatgpt-oauth]` 和所有 `[models."chatgpt/..."]` 段落；停掉代理进程（macOS/Linux: `pkill -f codex-oauth-proxy`;Windows PowerShell: `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object CommandLine -match 'codex-oauth-proxy' | ForEach-Object { Stop-Process -Id $_.ProcessId }`)。

## 合规提示

复用 ChatGPT 订阅的 OAuth 登录态供第三方客户端调用，属于 OpenAI 服务条款的灰色地带（与 opencode 等工具的 codex-auth 插件相同）。token 只在本机 localhost 转发，不会外泄，但账号风险请自行评估。
