# dsh-openai-gateway

**Expose [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) as an OpenAI-compatible API server** — `POST /v1/chat/completions` (stream + non-stream) and `GET /v1/models`. Every API call is backed by a **real agent session** with tools and a workspace, so any OpenAI client (SDK, Raycast, scripts, IDE plugins…) can drive your agent by just filling in a base URL and an API key.

把 DeepSeek Harness 暴露为 OpenAI 兼容 API 服务端：每次 API 调用背后是带工具、带工作区的真实 Agent 会话。

![Version](https://img.shields.io/badge/version-0.1.0-blue) ![dsh](https://img.shields.io/badge/dsh-0.1.1--rc.2-green) ![License](https://img.shields.io/badge/license-MIT-black)

## 特性

- **OpenAI 兼容**：`/v1/chat/completions`（`stream: true` 走 SSE）、`/v1/models`、`/v1/models/:id`，标准错误格式，任何 OpenAI SDK 直接可用
- **真实 Agent 后端**：每次调用都经过完整 agent 循环——模型、工具、工作区、会话日志全部生效；响应携带真实 token usage
- **双会话模型**：
  - *无状态（默认）*：`messages` 全量拼为一条 prompt，回合结束即销毁会话，零残留
  - *粘性会话（扩展）*：首次带 `X-DSH-Session: new` 创建常驻会话，后续带返回的 `dsh_session_id` 续用——只发最新一条消息，工作区与上下文跨请求连续（活体复用，冷会话自动 resume）
- **推理流映射**：推理模型的思考增量映射为 `delta.reasoning_content`（DeepSeek 风格）
- **独立监听 + 自理鉴权**：Bearer key（SHA-256 常量时间比较），未配置时首启自动生成并以 0600 权限落盘
- **模型路由**：`model` 接受 `provider/model`、裸模型名（对照 dsh 目录解析）或 `default`（跟随 dsh 当前默认模型）

## 为什么是独立端口？

dsh 共享 Web 服务器的路由会被登录门插件（如 `@xgone/dsh-remote`）整体包装，纯 Bearer 的 API 客户端拿不到浏览器会话。本插件自建 `node:http` 监听，鉴权完全自理——API 流量与 Web UI 的登录门互不干扰，可分别暴露。

## 安装

```sh
dsh plugin --profile web add github:backrooms-yrc/dsh-openai-gateway#v0.1.0
# 首次新增包需重启一次 dsh web；启动日志与
# $DSH_HOME/openai-gateway/api-keys.json 中可拿到自动生成的 API key
```

> 本地开发：`dsh plugin --profile web add /path/to/dsh-openai-gateway`（link 安装不装 peer 依赖，需自行保证 `@deepseek-ai/dsh-agent` / `dsh-llm` / `dsh-session` / `dsh-home-paths` / `schemastery` 可解析——可建 `node_modules/@deepseek-ai/` 符号链接指向 dsh CLI 的内部副本）。

针对 dsh `0.1.1-rc.2` 实现并测试（开发者预览，暂无兼容承诺）。

## 快速开始

```bash
# 非流式
curl http://127.0.0.1:41540/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"default","messages":[{"role":"user","content":"你好"}]}'

# 流式
curl -N http://127.0.0.1:41540/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"default","stream":true,"messages":[...]}'

# 粘性会话：第一轮创建，第二轮续用（Agent 记得上一轮）
curl -X POST ... -H "X-DSH-Session: new"  -d '{"messages":[{"role":"user","content":"我的暗号是蓝鲸"}]}'
curl -X POST ... -H "X-DSH-Session: openai-xxxx-..." -d '{"messages":[{"role":"user","content":"我的暗号是什么？"}]}'
```

## 配置（profile/home patch 层）

```yaml
- id: openai-gateway
  config:
    enabled: true
    host: 127.0.0.1        # 只绑回环，对外走反代
    port: 41540
    apiKeys: []            # 留空则首启自动生成并落盘（0600）
    sessionMode: both      # both | stateless
    maxSessions: 16        # 粘性会话簿记上限（LRU）
    timeoutSeconds: 300    # 单轮超时，超时取消 Agent 并返回 504
    defaultModel: ''       # 'provider/model' 或裸模型名；空 = 跟随 dsh 默认
    workspace:
      cwd: ''              # Agent 工作目录；空 = $DSH_HOME/openai-gateway/workspace
```

## 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/chat/completions` | 流式/非流式；`max_tokens` 映射单请求输出上限 |
| GET | `/v1/models`、`/v1/models/:id` | 从 dsh 模型目录读取，模型名为 `provider/model` |
| GET | `/healthz` | 免鉴权探活 |

响应扩展字段（不破坏标准客户端）：`dsh_session_id`、`dsh_tool_calls`。工具调用在 SSE 中以注释帧 `: dsh tool-call <name>` 呈现。

## 反向代理（nginx，SSE 注意事项）

```nginx
location ^~ /v1/ {
    proxy_pass http://127.0.0.1:41540;
    proxy_buffering off;          # SSE 必须关缓冲
    proxy_read_timeout 3600s;
    proxy_set_header Host $host;
}
```

## 已知限制（v0.1）

- `tool_calls` 不投影为 OpenAI 工具调用帧（只计数 + SSE 注释）；请求体的 `tools`/`tool_choice` 忽略
- 无每 key 配额/限速
- `maxSessions` 为簿记上限，被逐出簿记的旧 Agent 由 dsh 注册表按自身策略回收

## License

MIT
