# 测试与版本验证

## 自动回归

无需 npm install，在仓库根目录执行：

```sh
node --test
```

测试使用 Node 内置 `node:test`，只操作临时目录、合成凭据及 loopback 测试服务。OAuth 和模型上游由测试替身响应；不会读取个人 `auth.json`，不会调用真实模型，也不消耗订阅额度。

覆盖内容：

- 配置校验器缺失、超时、拒绝、Python fallback、Windows 命令入口。
- 拒绝写入时原文件不变；成功写入保留原始备份；无变更不重写；检测用户并发修改。
- 模型同步的真实元数据、CRLF、用户推理偏好及个人覆盖。
- 凭据刷新成功、失败、401 重试、并发刷新及刷新期间切换登录。
- macOS/Linux 权限收紧、符号链接目标保留；Windows 访问控制列表保留。
- 实例身份核对、错误停止密钥、卸载预览、受管配置清理、重复清理与凭据保留。
- 实际后台进程的启动、重复启动、受控停止，以及端口被其他程序占用和启动失败时 Hook 正常结束。

GitHub Actions 在 Windows、macOS、Linux 上分别运行 Node 18 和 Node 24。平台专用权限测试在其他平台显示为 skip；skip 不表示在该平台通过。运行结果见 [Actions](https://github.com/P-A-N-52/kimi-codex-oauth/actions)。

## 真实环境记录

- 作者报告：macOS、Kimi Code **0.39.0** 的既有版本真实账号路径已使用验证；macOS 和 Node 具体版本未记录。
- 这条历史记录不替代 v0.1.1 的实际账号验收，也不代表所有系统均完成了实际账号使用。
- 2026-09-06：Windows、Node **24.18.0**、本机 Kimi Code **0.41.0** 完成隔离配置校验，合法候选配置被接受、错误 TOML 被拒绝。这个检查没有发送真实模型请求。
- CI 验证的是隔离环境中的脚本行为，不验证账号权限、OpenAI 上游可用性或 Kimi 市场审核。

## 手动验收

在已经正常登录 Codex 的测试设备上：

1. 按 README 的升级说明处理旧代理，然后在 Kimi Code 安装指定 Release。
2. 执行 `/kimi-codex-oauth:setup`，确认实际写入了 provider 和账号可用模型。
3. 运行 `/kimi-codex-oauth:status`，检查健康状态；使用 `/model` 选择真实返回的别名，完成一次短提示词请求。
4. 再运行 setup，确认无变化时不重写配置、不改变个人推理偏好和 overrides。
5. 按 README 先预览卸载，再清理并移除插件；确认其他 provider、个人模型和 Codex 登录缓存仍保留，代理已停止。

记录插件版本、Kimi Code 版本、Node 版本、系统版本以及各步骤结果即可；请勿记录或上传 token。
