# kimi-codex-oauth

让 Kimi Code 使用本机 Codex CLI 的 ChatGPT OAuth 登录态，通过本地代理调用账号可用的 GPT 模型。当前版本 **0.1.1**，零 npm 依赖。

[更新记录](CHANGELOG.md) · [数据与权限](PRIVACY.md) · [测试说明](TESTING.md) · [问题反馈](https://github.com/P-A-N-52/kimi-codex-oauth/issues)

## 工作方式

```text
Kimi Code → http://127.0.0.1:8317/v1/responses
                       │
                       ├─ 读取 / 刷新本机 Codex OAuth 登录缓存
                       └─ HTTPS → chatgpt.com/backend-api/codex/responses
```

Kimi Code 通过普通的 `openai_responses` provider 接入，无需给 Kimi Code 打补丁。代理只监听 `127.0.0.1`；access token 临近过期时自动刷新，成功后用私有临时文件原子写回凭据。

## 前置条件

- Node.js >= 18；无需 `npm install`。自动测试覆盖 Node 18 和 Node 24。
- 已安装 Codex CLI，并完成 `codex login` 的 ChatGPT 账号登录。
- 文件形式的 `~/.codex/auth.json` 中存在 OAuth 登录凭据。仅使用系统 keyring、或仅使用 API key 的登录不适用。
- 已安装 Kimi Code。配置写入优先调用 `kimi doctor`；找不到 Kimi 时才尝试 Python 3.11+ 的 `tomllib`。没有可用校验器就跳过写入并给出提示。

作者已在 macOS、Kimi Code **0.39.0** 的既有版本上实测使用；当时的 macOS 与 Node 版本未记录。各平台的自动回归与真实账号验证分开记录，见 [测试说明](TESTING.md)。

## 安装

在 Kimi Code 中：

```text
/plugins install https://github.com/P-A-N-52/kimi-codex-oauth/releases/tag/v0.1.1
/reload
/kimi-codex-oauth:setup
```

也可以安装仓库地址获取最新 Release，或使用本地插件目录。setup 会检查环境和登录状态、启动代理、运行受校验的配置同步，再完成一次真实模型请求。模型别名以本账号返回的 `chatgpt/*` 列表为准，之后用 `/model` 切换。

## 日常使用

- `/kimi-codex-oauth:setup`：配置或重新同步；没有变化时不改写文件。
- `/kimi-codex-oauth:status`：检查代理、登录模式和 token 有效期。
- `/kimi-codex-oauth:uninstall`：预览并清理受管配置、停止代理，然后移除插件。

SessionStart Hook 自动启动代理并同步模型。上游模型元数据决定上下文长度、输入能力和推理档位；新别名初始使用所支持的最高推理档，之后保留用户对 `default_effort` 的选择。

配置管理规则：

- 带 `# managed-by: kimi-codex-oauth` 的段落属于插件管理范围；移除标记后视为个人条目。
- 保留个人 overrides。模型退役或切到 API key 登录时，清理条件满足的受管模型；仍被默认/次级模型引用的别名保留。
- 获取模型失败时跳过同步，不据此删除模型。
- 写入前使用独立临时目录做配置校验；校验失败、超时或校验器缺失时保留原配置，Hook 仍正常结束。Python fallback 只检查 TOML 语法，不等同于 Kimi 完整配置校验。
- 每次实际改写前保存 `config.toml.bak-kimi-codex-oauth-*`，并在替换前检查原文件是否已被其他进程改动。备份可能含有其他 provider 的密钥，请妥善保存。

如需回退配置，先停止相关同步/编辑，确认当前配置与备份的差异，再用选定备份恢复；不要覆盖备份生成后新增的个人配置。

## 从 0.1.0 升级

旧代理会继续运行到进程退出，即使插件文件已经更新。v0.1.0 没有实例状态，v0.1.1 不会根据进程名猜测并终止它。

1. 在升级前确认默认 `8317` 端口上的旧进程。macOS/Linux 可用 `lsof -nP -iTCP:8317 -sTCP:LISTEN` 查 PID，再用 `ps -p <PID> -o pid=,command=` 核对它确实运行本插件的 `bin/codex-oauth-proxy.mjs`。
2. 只终止已确认的那个 PID，例如 macOS/Linux 的 `kill -TERM <PID>`。Windows 可先使用 `Get-NetTCPConnection` 查看监听者，再通过 `Get-CimInstance Win32_Process` 核对路径，最后 `Stop-Process -Id <PID>`。不要使用按名称批量杀进程的命令。
3. 按安装步骤安装新 Release 并运行 setup；status 的健康响应应显示 `version: "0.1.1"`。

从带实例状态的版本升级时，启动脚本可以核对并停止旧实例再启动新版本。旧 setup 生成的未标记条目仍按个人配置保留，不自动接管或删除。

## 停止代理与卸载

先通过 `/plugins info kimi-codex-oauth` 确认插件的实际目录。以下命令里的 `<插件目录>` 替换为该目录；设置过自定义环境变量时，清理时使用同一组设置。

预览，不修改配置也不停止进程：

```sh
node "<插件目录>/bin/uninstall.mjs" --dry-run
```

执行清理：

```sh
node "<插件目录>/bin/uninstall.mjs"
```

清理脚本只停止能核对身份的实例，并备份、校验和清理未被引用的受管配置。默认模型、次级模型池、个人 overrides 仍引用的别名会保留并列出；先把默认模型切换到可用的其他 provider，才能清理这些引用。个人条目始终保留。v0.1.0 的旧代理按上一节处理。

清理后，在开启新会话之前立即运行：

```text
/plugins remove kimi-codex-oauth
/reload
```

单独停止代理可以运行 `node "<插件目录>/bin/stop-proxy.mjs"`；插件仍启用时，下次会话会再次拉起。

卸载保留 Codex 登录缓存、日志和配置备份，不会执行 `codex logout`。Kimi 自身管理的插件副本按其插件管理行为处理。

## 路径与端口

- `CODEX_AUTH_PATH`：登录缓存路径，默认 `~/.codex/auth.json`。
- `CODEX_OAUTH_LOG`：日志路径，默认 `~/.codex/oauth-proxy.log`。
- `CODEX_OAUTH_PORT`：本地端口，默认 `8317`。
- `KIMI_CODE_HOME`：Kimi 数据目录，默认 `~/.kimi-code`。

实例状态文件位于 `<日志路径>.<端口>.state.json`，其中的停止密钥应保密。健康接口展示的 `ok` 仅代表能读取登录缓存；是否能实际调用模型仍以真实请求结果为准。

## 数据与账号说明

插件没有作者运营的中转服务或遥测。请求上下文和 access token 会发送给 ChatGPT 后端，refresh token 会发送给 OpenAI 登录端点；详见 [PRIVACY.md](PRIVACY.md)。

Responses/Models 本地接口的 `local-proxy` 是占位密钥，不提供调用鉴权；能连接本机端口的其他程序也可能调用。停止接口单独使用随机实例密钥。不要对外暴露代理端口。

复用 ChatGPT 订阅 OAuth 登录态供第三方客户端调用存在服务条款适用与账号风险；原项目将其提示为“灰色地带”，请使用者自行评估。本项目是独立第三方插件，不代表 Kimi 或 OpenAI 官方背书。

## 开发与维护

运行 `node --test` 执行隔离回归；CI 覆盖 Windows、macOS、Linux。维护者与问题反馈入口均为 [P-A-N-52/kimi-codex-oauth](https://github.com/P-A-N-52/kimi-codex-oauth)。采用 MIT 许可证。
