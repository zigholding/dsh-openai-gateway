# Changelog

本项目的所有显著变更都记录在此文件中。
格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [0.1.3] - 2026-10-19

### 新增

- `GET /v1/dsh/sessions`：会话列表，每项含 `dsh_workspace`、`dsh_session`、`name`
- 查询参数 `workspace` / `dsh_workspace` 按工作目录过滤（realpath；也可按已登记 Workspace 标题或目录 basename）
- 查询参数 `name` / `name_regex` 按会话名称正则过滤
- `POST|PATCH /v1/dsh/sessions/:id[/rename]`：重命名会话（body: `{ "name": "..." }`，亦接受 `title`）

## [0.1.2] - 2026-10-19

### 新增

- 按请求指定工作目录：`X-DSH-Workspace` 头或 body 字段 `dsh_workspace`（绝对路径，支持 `~/...`）；未指定时仍用 `config.workspace.cwd`
- 新建会话时若 cwd 对应已注册的 Web Workspace，自动 `attachSession`，侧栏归入该工作区而非「未分组」
- 响应扩展字段 `dsh_cwd`：回显本回合实际工作目录（realpath）

### 变更

- 粘性会话续用时忽略请求里的 workspace 覆盖，保留创建时的 cwd

## [0.1.1] - 2026-08-23

### 新增

- 监听地址落盘 `$DSH_HOME/openai-gateway/state.json`（host/port/pid/startedAt）：`port: 0` 随机端口场景与运维排查有了权威查询来源
- 端口冲突（EADDRINUSE）优雅处理：记录明确的 FATAL 日志与处置指引，不再让进程崩溃

### 变更

- README 重写为完整教程：端口发现与冲突处理、Python SDK 接入示例、粘性会话完整示例、配置参考表、故障排查表

## [0.1.0] - 2026-08-23

首个发布。

### 新增

- OpenAI 兼容 API 服务端：`POST /v1/chat/completions`（流式 SSE + 非流式）、`GET /v1/models`、`GET /v1/models/:id`、`GET /healthz`
- 真实 Agent 后端：每次调用走完整 agent 循环（模型/工具/工作区），响应携带真实 token usage
- 双会话模型：无状态（默认，回合即毁）与粘性会话（`X-DSH-Session: new` 创建、按 `dsh_session_id` 续用，支持冷会话自动 resume）
- 独立 HTTP 监听 + Bearer 鉴权（SHA-256 常量时间比较）；未配置 key 时首启自动生成并落盘 `$DSH_HOME/openai-gateway/api-keys.json`（0600）
- 模型路由：`provider/model`、裸模型名（对照 dsh 目录解析）、`default`（跟随 dsh 默认模型）
- 推理增量映射为 `delta.reasoning_content`（DeepSeek 风格）
- 单轮超时（默认 300s）：超时取消 Agent 并返回 504；流式期间客户端断开自动取消 Agent
- 响应扩展字段 `dsh_session_id` / `dsh_tool_calls`；SSE 工具调用注释帧

[0.1.3]: https://github.com/zigholding/dsh-openai-gateway/releases/tag/v0.1.3
[0.1.2]: https://github.com/zigholding/dsh-openai-gateway/releases/tag/v0.1.2
[0.1.1]: https://github.com/zigholding/dsh-openai-gateway/releases/tag/v0.1.1
[0.1.0]: https://github.com/zigholding/dsh-openai-gateway/releases/tag/v0.1.0
