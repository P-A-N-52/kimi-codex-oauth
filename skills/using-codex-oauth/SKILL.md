---
name: using-codex-oauth
description: 在 Kimi Code 中通过本机 Codex OAuth 登录使用 GPT 模型，配置、检查、升级和卸载本地代理。
---

# using-codex-oauth

本插件通过本地代理复用文件形式的 Codex OAuth 缓存。上游调用和 token 刷新经 HTTPS 发送到 ChatGPT/OpenAI，作者不提供中转服务。

## 入口

- 首次配置或同步：`/kimi-codex-oauth:setup`。
- 状态与版本：`/kimi-codex-oauth:status`。
- 切换模型：`/model` 选择配置中实际存在的 `chatgpt/*` 别名。
- 卸载清理：`/kimi-codex-oauth:uninstall`。

## 行为

SessionStart 拉起代理并同步模型；配置候选未通过校验、没有校验器或上游模型列表不可用时，不写配置，仍结束 Hook。实际写入前保留私有备份。未标记的个人条目和个人 overrides 保留。

代理默认监听 `127.0.0.1:8317`，读取 `~/.codex/auth.json`。支持环境变量 `CODEX_AUTH_PATH`、`CODEX_OAUTH_LOG`、`CODEX_OAUTH_PORT` 和 `KIMI_CODE_HOME`；安装、状态检查和卸载使用一致设置。

## 排障与升级

401/刷新失败时引导 `codex login`，不要展示或删除登录缓存。健康检查成功不等于模型请求成功。v0.1.0 没有实例状态，升级前需核对旧进程的端口和脚本路径再终止；不要使用批量杀进程命令。新版本通过专用实例控制密钥停止自己的代理。

卸载脚本支持 `--dry-run`，只清理未被引用的受管配置，保留 Codex 登录缓存、日志、备份和个人配置。随后立即移除插件并 reload，避免新会话重新拉起代理。

复用订阅 OAuth 登录态的服务条款适用与账号风险由使用者自行评估，不能承诺官方背书。数据接收方、文件权限和本地接口边界以插件根目录的 `PRIVACY.md` 为准。
