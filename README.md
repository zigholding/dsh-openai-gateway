# dsh-openai-gateway

把 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 暴露成 OpenAI 兼容 API。每次调用背后是带工具和工作区的真实 Agent 会话。插件自建 HTTP 监听和 Bearer 鉴权，不走 Web UI 的登录门。


## 安装

```sh
dsh plugin --profile web add github:zigholding/dsh-openai-gateway#v0.2.0
```

桌面版把 `web` 换成 `desktop`，在托盘打开的终端里执行。装完后完全退出再打开。

默认监听 `127.0.0.1:41540`（与 dsh 自己的端口无关）。实际地址和 key：

```sh
cat $DSH_HOME/openai-gateway/state.json      # host / port
cat $DSH_HOME/openai-gateway/api-keys.json   # 未配置时首次启动自动生成
curl http://127.0.0.1:41540/healthz
```

`DSH_HOME` 默认是 `~/.dsh`。端口被占用时看日志 `FATAL: port ... already in use`，改配置后重启。

```yaml
- id: openai-gateway
  config:
    port: 41540          # 0 = 系统分配，实际值见 state.json
    workspace:
      cwd: /path/to/project
    agentPreset: ""      # 空 = dsh 默认
    permissionPreset: ""
```

## 调用

```sh
curl http://127.0.0.1:$PORT/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"default","messages":[{"role":"user","content":"你好"}]}'
```

`model`：`default` 跟随 dsh 默认模型；`provider/model` 精确指定；裸模型名按目录匹配。OpenAI SDK 只改 `base_url` 为 `http://127.0.0.1:41540/v1`。

默认无状态：整段 `messages` 拼成一次请求，回合结束会话即销毁，网关不额外加提示词。要记住上下文，用粘性会话：

```sh
# 创建。响应里的 dsh_session_id 下次带回
curl ... -H "X-DSH-Session: new" -d '{"model":"default","messages":[...]}'
# 续用。只发最新一条 user 消息
curl ... -H "X-DSH-Session: openai-..." -d '{"model":"default","messages":[...]}'
```

## 新建会话时的覆盖

下列项只在**新建**会话时生效（无状态，或 `X-DSH-Session: new`）。续用粘性会话时忽略，沿用创建时的值。请求头和 body 都可以，body 优先。

| 作用 | 请求头 | body |
|---|---|---|
| 工作目录（绝对路径，支持 `~/`） | `X-DSH-Workspace` | `dsh_workspace` |
| agent preset | `X-DSH-Agent-Preset` | `dsh_agent_preset` |
| permission preset | `X-DSH-Permission-Preset` | `dsh_permission_preset` |

优先级：请求 > 插件配置 > dsh 默认。可用 preset：`GET /v1/dsh/presets`。

工作目录的 realpath 若与已登记 Workspace 一致，会话归入该组，否则落在「未分组」。

## 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/chat/completions` | 流式 / 非流式 |
| GET | `/v1/models`、`/v1/models/:id` | 模型目录 |
| GET | `/v1/dsh/sessions` | 会话列表。`?dsh_workspace=`、`?name=`（JS 正则）过滤 |
| POST/PATCH | `/v1/dsh/sessions/:id[/rename]` | body `{ "name": "..." }` |
| GET | `/v1/dsh/presets` | agent / permission preset |
| GET | `/healthz` | 免鉴权 |

响应额外字段：`dsh_session_id`、`dsh_cwd`、`dsh_agent_preset`、`dsh_permission_preset`、`dsh_tool_calls`。推理增量在 `delta.reasoning_content`。工具调用只计数，并以 SSE 注释 `: dsh tool-call <name>` 出现，不转成 OpenAI `tool_calls`。

## 常见问题

| 症状 | 处理 |
|---|---|
| `/healthz` 不通 | 看 `state.json`；端口占用就改 `port` 后重启 |
| `401 invalid_api_key` | 对照 `api-keys.json` |
| `404 model_not_found` / `session_not_found` | 模型用 `default`；会话用 `X-DSH-Session: new` 重建 |
| `400 invalid_workspace` | 路径须为存在的绝对目录 |
| `400 invalid_agent_preset` / `invalid_permission_preset` | 查 `GET /v1/dsh/presets` |
| `503 agent_preset_unavailable` | 宿主没有 preset 服务；去掉该参数即用默认 |
| 流式一次性返回 | 反代加 `proxy_buffering off` |

本地开发：`dsh plugin --profile web add /path/to/dsh-openai-gateway`。纯 JS，无构建。针对 dsh `0.1.1-rc.2`。

MIT
