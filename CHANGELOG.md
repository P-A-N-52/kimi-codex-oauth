# Changelog

## 0.2.0 — 2026-09-23

- 新增额度查询：代理提供 `GET /quota`(经 `wham/usage` 读取套餐、限流窗口用量与重置时间，并尽力读取 `wham/rate-limit-reset-credits` 的可用重置卡）,`bin/quota.mjs` 渲染中文额度卡片，新增 `/kimi-codex-oauth:quota` 命令。
- 新增重置卡消耗：用户确认后 `POST /quota/consume-reset`（或 `node bin/quota.mjs --consume-reset`）按官方客户端契约消耗一张重置卡并返回刷新后的额度；消耗不可撤销，命令提示词要求先确认。
- 新增桌面展示：代理在 `GET /`（同 `/quota/view`）提供自包含的中文仪表盘页面（每分钟自动刷新、倒计时每秒跳动、确认后消耗重置卡；CSP 锁定、无外部资源）;`bin/quota.mjs --statusline` 输出单行额度摘要，可接入 `tui.toml` 的 `[status_line].command`，失败时静默回退内置底栏。
- 额度接口带 60 秒缓存；上游错误只记录状态码，不返回、不记录响应正文。
- 未标记的旧 `chatgpt/*` 别名若仍指向插件 provider 且模型已从上游列表消失，会在上游列表可信时自动清理；被默认/次级模型或 overrides 引用的仍保留并提示。新模型插入到 ChatGPT 分组最前面。

## 0.1.1 — 2026-09-06

- 配置校验器不可用、超时或拒绝候选配置时跳过写入；SessionStart 仍正常结束。Windows 支持通过命令解释器运行 `kimi.cmd`；Kimi 不可用时尝试 Python 3.11+ 的 TOML 校验。
- 改写配置前保存私有备份，写入前检测其他进程的配置变更，并保留现有 CRLF 行尾。
- OAuth 刷新写回使用私有临时文件；保留 Windows 文件访问控制，收紧 macOS/Linux 权限。刷新失败、登录方式或账号发生变化时保留当前凭据。
- 日志不再记录 token 刷新或模型请求的上游错误响应正文。
- 新增实例鉴别、专用停止接口、`stop-proxy.mjs` 和可预览的卸载清理。保留个人条目、默认/次级模型引用及个人 overrides，清理前备份配置。
- setup 使用统一配置同步脚本，补齐作者信息、升级/卸载文档、隐私说明与 Node 内置自动测试。
- 新增 Windows、macOS、Linux 的 Node 18/24 CI。

升级提示：v0.1.0 代理没有实例状态，首次升级需要核对旧进程后手动停止；详见 README。Responses/Models 本地接口的调用鉴权方式未变。

## 0.1.0 — 2026-08-19

- 初始版本：Codex OAuth 本地代理、自动刷新、模型同步、Kimi Code 插件命令与 Hook。
- 作者报告在 macOS、Kimi Code 0.39.0 完成真实账号使用验证；当时的 macOS 与 Node 版本未记录。
