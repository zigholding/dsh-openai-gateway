# dsh-openai-gateway

**Expose [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) as an OpenAI-compatible API server** — `POST /v1/chat/completions` (stream + non-stream) and `GET /v1/models`. Every API call is backed by a **real agent session** with tools and a workspace, so any OpenAI client (SDK, Raycast, scripts, IDE plugins…) can drive your agent by just filling in a base URL and an API key.

把 DeepSeek Harness 暴露为 OpenAI 兼容 API 服务端：每次 API 调用背后是带工具、带工作区的真实 Agent 会话。

![Version](https://img.shields.io/badge/version-0.1.3-blue) ![dsh](https://img.shields.io/badge/dsh-0.1.1--rc.2-green) ![License](https://img.shields.io/badge/license-MIT-black)

## 工作原理

```
OpenAI 客户端 ──(可选: 反向代理 /v1)──▶ 插件独立 HTTP 监听 ──▶ dsh Agent 会话
                                        (自带 Bearer 鉴权)      (模型+工具+工作区)
```

dsh 共享 Web 服务器的路由会被登录门插件（如 `@xgone/dsh-remote`）整体包装，纯 Bearer 的 API 客户端拿不到浏览器会话。因此本插件**自建独立监听**、鉴权完全自理——API 流量与 Web UI 的登录门互不干扰，可分别暴露。

## 安装（完整流程）

### 1. 安装插件

```sh
dsh plugin --profile web add github:backrooms-yrc/dsh-openai-gateway#v0.1.1
```

### 2. 重启 dsh web

首次新增包需要重启一次：

```sh
# 先停掉正在运行的 dsh web，再以你的原参数启动，例如：
dsh web --host 127.0.0.1 --port 41539 --no-open
```

### 3. 找到你的端口和 API key

**端口**：默认 `127.0.0.1:41540`（这只是本插件的默认值，与 dsh 本身的端口无关，完全可以改）。权威查询方式——监听成功后插件会把实际地址写进状态文件，`port: 0`（随机端口）场景同样适用：

```sh
cat $DSH_HOME/openai-gateway/state.json
# {"host": "127.0.0.1", "port": 41540, "pid": 12345, "startedAt": "..."}
```

**API key**：未配置时首次启动自动生成一个，0600 权限落盘：

```sh
cat $DSH_HOME/openai-gateway/api-keys.json
# {"keys": ["sk-dsh-..."]}
```

**自检**：

```sh
curl http://127.0.0.1:41540/healthz
# {"ok":true,"service":"dsh-openai-gateway"}
```

### 4. 发起第一次调用

```sh
KEY=$(python3 -c "import json;print(json.load(open('$HOME/.dsh/openai-gateway/api-keys.json'))['keys'][0])")
PORT=$(python3 -c "import json;print(json.load(open('$HOME/.dsh/openai-gateway/state.json'))['port'])")

curl http://127.0.0.1:$PORT/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"default","messages":[{"role":"user","content":"你好"}]}'
```

> `DSH_HOME` 默认是 `~/.dsh`；用环境变量 `DSH_HOME` 自定义过的以实际为准。

## 端口说明（重要）

- `41540` 是**本插件的默认端口**，不是 dsh 官方约定。它被占用时插件不会启动 dsh 崩溃，但会记录 `FATAL: port ... already in use` 日志，且 `state.json` 不会更新、`/healthz` 不通——此时换一个端口即可；
- 修改端口（在 profile 的 `cordis.patch.yml` 或 `$DSH_HOME/cordis.patch.yml` 中）：

```yaml
- id: openai-gateway
  config:
    port: 41540   # 改成任意空闲端口；0 = 让操作系统随机分配（实际值见 state.json）
```

改完重启 dsh web 生效。

## 工作目录

Agent 的 cwd 决定工具读写/沙箱落点，也决定 Web UI 侧栏归属（cwd 与已登记 Workspace 的 `realpath` 一致时自动归入该组，否则落「未分组」）。

**优先级**（新建会话时）：请求覆盖 > `config.workspace.cwd` > `$DSH_HOME/openai-gateway/workspace`。

```yaml
# profile 的 cordis.patch.yml — 全局默认
- id: openai-gateway
  config:
    workspace:
      cwd: /home/jushen1/Allgo/notebook/gitlab/celever-dog
```

```sh
# 按请求覆盖（头或 body 均可；路径须绝对，支持 ~/...）
curl http://127.0.0.1:$PORT/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -H "X-DSH-Workspace: /home/jushen1/Allgo/notebook/gitlab/celever-dog" \
  -d '{"model":"default","messages":[{"role":"user","content":"pwd"}]}'
# 或 body: {"dsh_workspace":"/path/to/project", "model":"default", "messages":[...]}
# → 响应里的 dsh_cwd 是实际 realpath
```

粘性会话续用时**忽略**请求里的 workspace 覆盖，保留创建时的 cwd。

## 会话模型

- **无状态（默认）**：`messages` 全量拼为一条 prompt，回合结束即销毁会话，零残留。任何 OpenAI 客户端即插即用。
- **粘性会话（扩展）**：首次请求带 `X-DSH-Session: new` 头（或 body 扩展字段 `"dsh_session": "new"`）创建常驻会话，响应携带 `dsh_session_id`；后续请求带该 id（头或字段均可）复用同一 Agent——只发最新一条 user 消息，工作区与上下文跨请求连续（活体复用，dsh 重启后自动 resume 持久化会话）。

```sh
# 第一轮：创建会话并给它一个暗号
curl -X POST http://127.0.0.1:$PORT/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -H "X-DSH-Session: new" \
  -d '{"model":"default","messages":[{"role":"user","content":"我的暗号是蓝鲸，记住"}]}'
# → 响应里的 dsh_session_id 记下来

# 第二轮：只发新消息，Agent 记得上一轮
curl -X POST http://127.0.0.1:$PORT/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -H "X-DSH-Session: openai-xxxxxxxx-..." \
  -d '{"model":"default","messages":[{"role":"user","content":"我的暗号是什么？"}]}'
```

## 客户端接入

任何 OpenAI SDK 只需改 `base_url`。Python 示例：

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:41540/v1",   # 你的端口见 state.json；远程部署换成反代地址
    api_key="sk-dsh-...",                    # 见 api-keys.json
)

resp = client.chat.completions.create(
    model="default",                          # "default" = 跟随 dsh 当前默认模型
    messages=[{"role": "user", "content": "你好"}],
)
print(resp.choices[0].message.content)

# 流式 + 推理模型的思考增量（delta.reasoning_content，DeepSeek 风格）
stream = client.chat.completions.create(
    model="default", stream=True,
    messages=[{"role": "user", "content": "解释一下 SSE"}],
)
for chunk in stream:
    delta = chunk.choices[0].delta
    if getattr(delta, "reasoning_content", None):
        print("[思考]", delta.reasoning_content, end="", flush=True)
    if delta.content:
        print(delta.content, end="", flush=True)
```

模型名规则：`"default"` 跟随 dsh 默认模型；`"provider/model"` 精确路由（如 `deepseek-official/deepseek-v4-flash`，完整列表 `GET /v1/models`）；裸模型名会对照 dsh 目录自动匹配供应商。

## 配置参考

patch 层条目（`- id: openai-gateway` + `config:`），未写的键用默认值：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `host` | `127.0.0.1` | 只绑回环最安全，对外走反代 |
| `port` | `41540` | 端口；`0` = 随机（实际值写入 `state.json`） |
| `apiKeys` | `[]` | 留空自动生成并落盘（0600）；填数组则只用你给的 |
| `sessionMode` | `both` | `both` / `stateless`（后者拒绝粘性会话请求） |
| `maxSessions` | `16` | 粘性会话簿记上限（LRU） |
| `timeoutSeconds` | `300` | 单轮超时：取消 Agent 并返回 504 |
| `defaultModel` | `''` | 请求未指定 model 时的兜底；空 = dsh 默认 |
| `workspace.cwd` | `''` | 默认 Agent 工作目录；空 = `$DSH_HOME/openai-gateway/workspace`；可被 `X-DSH-Workspace` / `dsh_workspace` 覆盖 |

## 会话列表与重命名

```sh
# 列出全部有 cwd 的会话
curl -H "Authorization: Bearer $KEY" "http://127.0.0.1:$PORT/v1/dsh/sessions"

# 按工作区过滤（绝对路径 / Workspace 标题 / 目录 basename）
curl -H "Authorization: Bearer $KEY" \
  --get "http://127.0.0.1:$PORT/v1/dsh/sessions" \
  --data-urlencode "dsh_workspace=/home/jushen1/Allgo/notebook/gitlab/celever-dog"

# 名称正则（JavaScript RegExp）
curl -H "Authorization: Bearer $KEY" \
  --get "http://127.0.0.1:$PORT/v1/dsh/sessions" \
  --data-urlencode "name=巡检|explore"

# 重命名
curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  "http://127.0.0.1:$PORT/v1/dsh/sessions/$SESSION_ID/rename" \
  -d '{"name":"C4 巡检"}'
```

列表响应示例：

```json
{
  "object": "list",
  "data": [
    {
      "dsh_session": "openai-580f2438-2b17-4eae-b0b6-9d2dda2fe763",
      "dsh_workspace": "/home/jushen1/Allgo/notebook/gitlab/celever-dog",
      "name": "C4 巡检"
    }
  ]
}
```

## 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/chat/completions` | 流式/非流式；`max_tokens` 映射单请求输出上限 |
| GET | `/v1/models`、`/v1/models/:id` | 从 dsh 模型目录读取，模型名为 `provider/model` |
| GET | `/v1/dsh/sessions` | 会话列表；`?dsh_workspace=` / `?name=` 过滤 |
| POST/PATCH | `/v1/dsh/sessions/:id[/rename]` | 重命名；body `{ "name": "..." }` |
| GET | `/healthz` | 免鉴权探活 |

响应扩展字段（不破坏标准客户端）：`dsh_session_id`、`dsh_cwd`、`dsh_tool_calls`。工具调用在 SSE 中以注释帧 `: dsh tool-call <name>` 呈现。

## 反向代理（nginx，SSE 注意事项）

```nginx
# 在你的 dsh 站点 server 块里，加在现有 location / 之前（更长前缀优先匹配）
location ^~ /v1/ {
    proxy_pass http://127.0.0.1:41540;   # 插件端口，以 state.json 为准
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;                  # SSE 必须关缓冲，否则流式会被攒包
    proxy_read_timeout 3600s;             # Agent 单轮可能较长
    proxy_send_timeout 3600s;
}
```

之后客户端用 `https://你的域名/v1` 作为 base URL，TLS 由 nginx 负责。

## 故障排查

| 症状 | 原因与处理 |
|---|---|
| 连接被拒 / `/healthz` 不通 | 插件没起来：查 `state.json` 是否有 `startedAt`；端口被占会记 `FATAL: port ... in use`，换 `port` 后重启 |
| `401 invalid_api_key` | key 不对——对照 `api-keys.json`，或确认配置的 `apiKeys` 生效（重启） |
| `404 model_not_found` | 模型名写错；`GET /v1/models` 看完整列表，或直接用 `default` |
| 粘性会话 `404 session_not_found` | 会话 id 不对/已被回收，或 `sessionMode: stateless`；用 `X-DSH-Session: new` 重新创建 |
| `504 timeout` | 单轮超过 `timeoutSeconds`（默认 300s）被取消；调大配置或精简任务 |
| `400 invalid_workspace` | 路径相对/不存在/不是目录；改用绝对路径，或先在 Web UI 里把该目录登记为 Workspace |
| `400 invalid_name_regex` | `name` / `name_regex` 不是合法 JS 正则 |
| `400 invalid_title` | 重命名标题清洗后为空 |
| 会话落在「未分组」 | cwd 与已登记 Workspace 的 realpath 不一致（symlink 两边写法不同也算）；对照 `dsh_cwd` 与 `~/.dsh/storages/workspace.json` |
| 流式响应一次性全出 | 反代没关缓冲——nginx 加 `proxy_buffering off` |

## 已知限制（v0.1）

- `tool_calls` 不投影为 OpenAI 工具调用帧（只计数 + SSE 注释）；请求体的 `tools`/`tool_choice` 忽略
- 无每 key 配额/限速
- `maxSessions` 为簿记上限，被逐出簿记的旧 Agent 由 dsh 注册表按自身策略回收

## 本地开发

```sh
git clone https://github.com/backrooms-yrc/dsh-openai-gateway
dsh plugin --profile web add /path/to/dsh-openai-gateway
```

link 安装不安装 peer 依赖，需自行保证 `@deepseek-ai/dsh-agent` / `dsh-llm` / `dsh-session` / `dsh-home-paths` / `schemastery` 可解析（可在插件目录建 `node_modules/@deepseek-ai/` 符号链接指向 dsh CLI 的内部副本）。纯 JS 无构建步骤。针对 dsh `0.1.1-rc.2` 实现并测试（开发者预览，暂无兼容承诺）。

## License

MIT
