# Changelog

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
