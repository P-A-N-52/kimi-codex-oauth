# AGENTS.md — kimi-codex-oauth

## 项目与约束

这是 Kimi Code 的本地插件，以普通 openai_responses provider 接入 Codex OAuth 后端。只用 Node 内置模块，运行时 Node >= 18，不引入 npm 依赖或构建步骤。

- HTTP 只监听 127.0.0.1。OAuth 凭据仅发送给对应的 OpenAI/ChatGPT HTTPS 端点，没有作者中转服务；准确数据流见 PRIVACY.md。
- 任何测试、命令、日志不得展示真实 access/refresh token、实例停止密钥或完整私有配置。
- ensure-proxy 与 sync-models 的失败必须 exit 0，不能阻塞 SessionStart；但 exit 0 不代表操作成功。无法验证候选配置时绝不写入。
- auth.json 和 config.toml 的写入使用私有临时文件和原子 rename。保留 Windows DACL，收紧 POSIX 权限；配置写入前保留私有备份并检查并发改动。
- 带完整行 `# managed-by: kimi-codex-oauth` 的段落由插件管理；未标记条目归用户。个人 overrides、默认/次级模型引用必须保留。上游失败时不清理模型。
- API key 登录不适用于此代理。原项目提示的订阅 OAuth 账号/服务条款风险不得被改写为获官方授权或无风险。
- 停止代理需核对实例身份和控制密钥；不能按照 Node.js 进程名批量终止，也不能因为残留 PID 文件就发送信号。

## 文件

- bin/codex-oauth-proxy.mjs：Responses/Models/health 代理，OAuth 刷新和受控停止。
- bin/ensure-proxy.mjs：幂等启动和识别旧版本。
- bin/sync-models.mjs：根据上游真实元数据同步受管配置。
- bin/private-file.mjs：私有文件权限与原子替换。
- bin/config-file.mjs：配置校验、备份和保守清理。
- bin/proxy-control.mjs：实例状态和停止协议。
- bin/stop-proxy.mjs、bin/uninstall.mjs：停止和清理 CLI。
- commands/、skills/：面向用户的命令提示词和使用说明。
- tests/：Node 内置测试；CI 在三个系统与 Node 18/24 上运行。

## 验证与风格

执行 `node --test`。自动测试只使用隔离临时目录、合成凭据、mock 上游和 loopback 服务；实际账号验收按 TESTING.md 单独记录，不能用模拟测试冒充。

ESM、2 空格缩进、单引号、分号。代码注释说明原因；面向用户文档使用中文。保持小型模块，不引入与当前功能无关的架构。

用户报告的历史环境：macOS、Kimi Code 0.39.0 已实测；系统与 Node 版本未记录。此事实不能证明新版本完整的真实账号回归通过。
