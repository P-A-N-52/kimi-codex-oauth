# 数据与权限说明

本插件在本机启动 Node.js 代理，并为 Kimi Code 配置一个本地 Responses provider。插件作者不运营中转服务器，插件没有遥测或统计上报。

## 本地读取与写入

- **Codex 登录缓存**：读取并在 OAuth 刷新成功后更新 `~/.codex/auth.json`，可通过 `CODEX_AUTH_PATH` 指定。它包含敏感登录凭据，不应贴到聊天、Issue 或日志中。插件当前支持文件形式的缓存，不读取系统 keyring。
- **Kimi 配置**：读取 `KIMI_CODE_HOME/config.toml`；默认位置是 `~/.kimi-code/config.toml`。自动同步和卸载只处理带 `# managed-by: kimi-codex-oauth` 标记的配置，保留个人覆盖和仍被引用的模型。
- **配置备份**：实际改写前在原目录保存 `config.toml.bak-kimi-codex-oauth-*`。备份可能包含配置中其他 provider 的 API key，按敏感文件保护，不适合上传。
- **代理日志**：默认 `~/.codex/oauth-proxy.log`，可通过 `CODEX_OAUTH_LOG` 指定。记录时间、模型名、输入项数量、HTTP 状态和运行错误；不主动记录 token、完整提示词、回复或上游错误响应正文。
- **实例状态**：日志文件名后追加 `.<端口>.state.json`。包含进程 ID、版本、实例标识和专用停止密钥；它不是 OAuth token，但同样不能公开。正常停止代理时删除该实例的状态文件。

凭据和配置通过同目录私有临时文件加原子替换写入。macOS/Linux 去掉组和其他用户的访问位，只保留原文件所有者的读写位；Windows 在写入内容前复制原文件的 Windows 访问控制列表，原文件不存在时设置当前用户专用权限。Windows 原文件已有的授权会被保留，不会替用户撤销已有的共享授权。权限设置失败时拒绝替换文件。

## 网络数据流

代理只监听 `127.0.0.1`，默认端口 `8317`。它会通过 HTTPS 访问以下 OpenAI 服务：

- `chatgpt.com/backend-api/codex/responses`：发送 Kimi Code 交给当前 provider 的输入、上下文、工具定义或结果，以及 access token 和账号标识；接收模型回复。
- `chatgpt.com/backend-api/codex/models`：发送 access token 和账号标识，获取账号可用模型及元数据。
- `auth.openai.com/oauth/token`：发送 refresh token 和 Codex 的公开客户端 ID，刷新登录凭据。

因此，准确的描述是“没有插件作者运营的中转服务”，而不是“token 和内容永不离开本机”。上游数据处理受相应服务条款和账号设置约束；本地代理设置 `store=false` 不代表对上游保留策略作额外保证。

## 本地接口边界

`/v1/responses` 和 `/v1/models` 沿用本地访问方式，配置中的 `local-proxy` 是占位值，不提供调用鉴权。能连接本机端口的其他程序也可能调用这些接口。请在自己的可信设备上使用，不要把端口暴露到局域网或公网。

停止接口单独使用每个实例的随机控制密钥。停止脚本先核对健康响应中的服务名、实例标识和进程 ID，再发送停止请求；不会按照进程名批量杀死 Node.js。

## 卸载与保留

清理脚本停止可确认身份的代理、备份配置并清理符合条件的受管段落；Codex 登录缓存、个人模型条目、被引用的受管条目、日志和配置备份保留。卸载插件不会执行 `codex logout`，也不会撤销或删除用户的 Codex 登录凭据。

问题反馈：[GitHub Issues](https://github.com/P-A-N-52/kimi-codex-oauth/issues)。提交前移除提示词、个人路径及所有凭据；不要上传 `auth.json`、实例状态文件或未经脱敏的配置备份。
