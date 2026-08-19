# AGENTS.md — kimi-codex-oauth

> 本文件面向 AI 编码代理，介绍本项目的结构、约定与工作方式。阅读前无需任何先验知识。

## 项目概述

`kimi-codex-oauth` 是一个 **Kimi Code 插件**（不是独立应用，没有 package.json / pyproject.toml 等清单）。它让 Kimi Code 复用本机 Codex CLI 的 ChatGPT OAuth 登录态（`~/.codex/auth.json`)，从而在 Kimi Code 中直接使用 GPT 模型。

运行时架构：

```
Kimi Code ──> http://127.0.0.1:8317/v1/responses (本地代理，零依赖 Node >= 18 单文件脚本)
                 │  读取/自动刷新 ~/.codex/auth.json，注入 chatgpt-account-id 等必需请求头，规范化请求体
                 ▼
           https://chatgpt.com/backend-api/codex/responses
```

Kimi Code 侧通过 `~/.kimi-code/config.toml` 中一个普通的 `openai_responses` provider(`[providers.chatgpt-oauth]`）接入，无需对 Kimi Code 本身打补丁。

注意：项目目录名是 `kimi-codex-oath`（拼写如此），但插件名（`kimi.plugin.json` 的 `name`）是 `kimi-codex-oauth`。

## 目录结构与模块划分

```
kimi.plugin.json            插件清单：声明 commands/、skills/ 目录和 SessionStart hook
bin/
  codex-oauth-proxy.mjs     核心：本地 HTTP 代理（约 290 行，仅用 node: 内置模块）
  ensure-proxy.mjs          幂等启动代理（已在运行则直接退出；永远 exit 0,fail-open)
  sync-models.mjs           把上游模型列表同步进 ~/.kimi-code/config.toml（永远 exit 0)
commands/
  setup.md                  /kimi-codex-oauth:setup 斜杠命令的提示词（教代理一步步配置）
  status.md                 /kimi-codex-oauth:status 斜杠命令的提示词（健康检查与排障）
skills/using-codex-oauth/SKILL.md   使用说明与排障技能，供 Kimi Code 在相关话题时加载
README.md                   面向用户的文档（中文）
```

没有 src/lib/test 等目录；三个 `.mjs` 脚本就是全部可执行代码，各自独立、可直接 `node bin/xxx.mjs` 运行。

### 关键行为约定（改动代码时必须保持）

- **零依赖**：只能用 Node 内置模块（`node:http`、`node:fs` 等），目标运行时 Node >= 18（依赖顶层 `await`、全局 `fetch`、`AbortSignal.timeout`)。不得引入 npm 依赖。
- **fail-open**:`ensure-proxy.mjs` 与 `sync-models.mjs` 由 SessionStart hook 调用，任何失败都必须 exit 0，绝不能阻塞会话启动。
- **只监听 `127.0.0.1`**；token 只在 localhost 转发，绝不外发。端口可用 `CODEX_OAUTH_PORT` 环境变量覆盖（默认 8317)；路径可用 `CODEX_AUTH_PATH`、`CODEX_OAUTH_LOG`、`KIMI_CODE_HOME` 覆盖。
- **与 Codex CLI 共存**：刷新 token 后写回 `~/.codex/auth.json` 采用「写前重读合并 + 临时文件原子 rename」；并发刷新用 single-flight(`refreshPromise`）合并。
- **config.toml 托管约定**(`sync-models.mjs`): 带 `# managed-by: kimi-codex-oauth` 标记的段落会被纠回上游值；去掉标记即用户自有、永不触碰；`[models."chatgpt/x".overrides]` 永远保留；`default_effort` 只在创建时设置（取最高推理档），之后不纠回；没有变动时一个字节都不写。**会删除的例外**：受管条目在上游列表中消失（模型退役）或登录方式切成 API key 时会被清理——但被 `default_model` / 次级模型池引用的别名保留并打印警告；无标记的用户自有条目永不删除。仅当明确知道认证状态时才动作（上游拉取失败 = 跳过，绝不误删）。推理档位只接受线上协议真实值 `none/minimal/low/medium/high/xhigh/max`（上游列表里的 `ultra` 是客户端委托模式，已过滤）。slug 必须匹配 `SLUG_RE`（保证 TOML 头安全）。**写入前必须过校验**：候选内容写进沙箱 `KIMI_CODE_HOME` 跑 `kimi doctor`（失败回退 python3 tomllib)，校验不过则拒绝写入、保持原文件不动。
- **API key 登录检测**:`auth.json` 为 apikey 模式（无 `tokens`）时，`/healthz` 返回 `auth_mode` 与 `hint`,`/v1/responses` 返回明确报错，引导用户改用标准 provider（本插件只服务 ChatGPT 订阅 OAuth)。
- **请求体规范化**（代理）: 强制 `store=false`、`stream=true`，补默认 `instructions`，剥离后端拒绝的参数（`BODY_STRIP` 集合）。
- **HTTP 端点**:`POST /v1/responses`（兼 `/responses`)、`GET /v1/models`(5 分钟缓存，失败回退静态列表，响应里 `live` 字段标记是否真实上游数据）、`GET /healthz`。上游 401 时强制刷新 token 重试一次。

## 构建、测试与验证

没有构建步骤、没有包管理器、没有测试框架、没有 CI。验证方式为手动 / 端到端：

```bash
node --version                                   # 必须 >= 18
node bin/ensure-proxy.mjs                        # 启动代理（幂等）
curl -s http://127.0.0.1:8317/healthz            # 应返回 ok:true 及 token 有效期
curl -s http://127.0.0.1:8317/v1/models          # 模型列表（live:true 表示来自上游）
node bin/sync-models.mjs                         # 同步 config.toml（无变动则不写）
```

端到端验证（需要本机已 `codex login` 且 Kimi Code 已配置 provider):

```bash
kimi -m chatgpt/gpt-5.6-luna -p "只回复 ok 两个字母"   # 注意 -m 必须在 -p 之前
```

日志位置：`~/.codex/oauth-proxy.log`（排障先看这里）。

## 代码风格

- ESM(`.mjs`),2 空格缩进，单引号，行尾分号。
- 文件顶部用块注释说明脚本用途与关键不变量；代码内注释用英文、简洁、只解释"为什么"。
- 面向用户的文档（README、commands/、skills/）用**中文**书写，技术术语保留英文原文。
- 配置项集中为文件顶部的 `const`，支持环境变量覆盖。
- 保持极简：不做超出需求的抽象与可配置性。

## 安全与合规注意事项

- `~/.codex/auth.json` 含有真实 OAuth token：**任何命令、日志、输出都不得打印 token 内容**（检查时用 jq/python3 只判断字段存在性）。
- 写 `auth.json` 与 `config.toml` 一律用临时文件 + `rename` 原子替换。
- 复用 ChatGPT 订阅登录态供第三方客户端调用属于 OpenAI 服务条款灰色地带（README 有明确提示），相关改动不要弱化这一提示。
- 客户端 ID(`app_EMoamEEZ73f0CkXaXp7hrann`）是 Codex CLI 的公开客户端 ID，硬编码在代理中。
