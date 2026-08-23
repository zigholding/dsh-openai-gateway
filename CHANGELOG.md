# Changelog

本项目的所有显著变更都记录在此文件中。
格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循 [SemVer](https://semver.org/lang/zh-CN/)。

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

[0.1.0]: https://github.com/backrooms-yrc/dsh-openai-gateway/releases/tag/v0.1.0
