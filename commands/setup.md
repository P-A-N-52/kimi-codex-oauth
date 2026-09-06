---
description: 配置本机 Codex OAuth 代理并通过校验同步 Kimi Code 模型
---

为用户配置 kimi-codex-oauth，基于实际检查完成以下步骤。

1. 确定插件目录：优先使用 `KIMI_PLUGIN_ROOT`，否则使用 `/plugins info kimi-codex-oauth` 的实际目录。确定有效的 `CODEX_AUTH_PATH`、`CODEX_OAUTH_LOG`、`CODEX_OAUTH_PORT` 和 `KIMI_CODE_HOME`，未设置时使用 README 默认值。Windows 使用对应 PowerShell 环境变量语法。
2. 检查 Node >= 18，以及 OAuth 缓存文件中的 access/refresh token 字段是否存在。只报告字段存在性，不读取到聊天、不打印字段值。API key 登录或系统 keyring 中无文件凭据时说明当前插件不适用。
3. 运行 `node "<插件目录>/bin/ensure-proxy.mjs"`。请求实际端口的 `/healthz`，确认服务名、版本、`has_tokens` 和 `has_account_id`。v0.1.0 旧代理需要按 README 核对具体进程后停止再升级，不得按进程名批量终止。
4. 运行 `node "<插件目录>/bin/sync-models.mjs"`。配置修改全部通过这个脚本进行，不手工追加静态模型或绕过校验。脚本 exit 0 只表示不阻塞会话；仍须检查输出与实际配置是否已完成同步。校验器不可用时安装/修复 Kimi Code 或 Python 3.11+ 后再试；不得跳过校验。
5. 从实际 `/v1/models` 和配置中选择账号可用的 `chatgpt/*` 别名，运行一次 `kimi -m <实际别名> -p "只回复 ok"`。失败时根据健康状态和脱敏日志诊断，不以 healthz 成功代替模型验证。
6. 报告代理版本、配置变更、备份位置和模型请求结果，提醒用 `/model` 选择模型。个人配置和未带托管标记的旧版本条目保留。
