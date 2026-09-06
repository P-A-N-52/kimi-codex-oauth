---
description: 检查 ChatGPT OAuth 代理、版本与登录状态
---

检查 kimi-codex-oauth 并报告实际结果：

1. 根据环境变量与 README 默认值确定端口、登录缓存和日志路径。获取 `/healthz`，检查 `service`、`version`、`has_tokens`、`has_account_id`、`access_token_expires_in_s` 和 `last_refresh`。不要读取或展示 token、实例停止密钥或完整配置。
2. 代理不在运行时，可运行插件目录中的 `bin/ensure-proxy.mjs`。若端口已由旧版本或身份未知的进程使用，按 README 核对具体进程；不要批量终止 Node.js。升级后健康响应须显示新的版本。
3. 若登录方式是 API key，说明此插件不适用，建议使用普通 provider。若刷新失败，引导用户 `codex login`；不要主动删除其登录缓存。
4. 用户要求验证可用性时，从实际模型列表选择别名，执行一次短提示词请求。报告是否真的成功；缓存文件可读、token 未过期和真实模型调用成功是不同状态。
5. 排障只读取必要的日志尾部并脱敏。日志默认 `~/.codex/oauth-proxy.log`；macOS/Linux 可用 `tail`，PowerShell 可用 `Get-Content -Tail`。不上传登录缓存、实例状态或配置备份。

报告：进程/版本、认证模式、凭据有效期、最近刷新时间，以及真实请求是否进行、是否成功。
