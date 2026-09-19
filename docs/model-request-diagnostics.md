# 模型请求全量记录

自应用 0.1.292、Relay 协议 90 起，全量日志默认关闭。只有启动环境显式设置 `CODEX_QUOTA_FULL_REQUEST_DIAGNOSTICS=1`，并且 Router 配置了 `usageEventPath`，才会向同目录的 `model-request-diagnostics.jsonl` 追加记录。没有设置开关或没有数据路径时均不创建该文件。它是独立的诊断文件，不改变 Token 计账、费用或右上角轻量状态的内容。

关闭全量日志不影响右上角的 292 状态：Router 仍会读取当前任务最近一次官方 `x-codex-turn-state` 的 UTF-8 字节长度，只把任务 ID、长度、模型和观察时间写入现有用量事件通道及缓存，供跨进程 Widget 读取。该通道不写入 state 原值，也不把轻量状态追加到全量诊断文件。

## 记录范围

- Router 的所有上游 HTTP 请求，包括 `/responses`、`/models`、辅助和未来 API 路径，成功、292、312、4xx、5xx 均记录。没有任务 ID 的请求也记录。
- 官方 Responses WebSocket 的握手、每次 `response.create`（含预热）和所有上游响应消息；其他转发消息保留在连接记录中。
- 自定义模型 WebSocket 转 HTTP 后发出的实际请求与上游响应。自定义预热明确记为 `local-websocket-prewarm`，没有上游状态码。
- 其他 API WebSocket 的握手与双向消息（含二进制消息）。

这里的“全量”指经过模型 Router 的流量，不包括浏览器、工具自己的联网、账号额度查询或其他程序流量。Chat 兼容模型在 Router 层记录的是送给兼容代理的 Responses 请求和它返回的响应，不将兼容代理内部的 Chat Completions 请求冒充为 Router 的原始请求。未通过路由校验、根本未发往上游的请求不产生上游记录。

启用后会**完整保留请求/响应正文、所有头字段、Authorization/API Key、Cookie、`current_turn_state` 和 `x-codex-turn-state` 原值**。不做脱敏或正文截断，不将原文写入普通 `injector.log` 或测试归档。JSONL 新文件使用 0600、目录创建使用 0700；Windows/WSL 共享目录的实际访问权限仍由其文件系统/ACL 决定，权限无法收紧时会明确警告。

单个文件达到 256 MiB 后按时间戳轮换；旧分片不自动删除，所有请求仍保留。轮换限制的是单文件大小，不是总占用，长期诊断结束后应由用户明确决定归档或删除。分析命令会自动读取同目录下该基础文件及其轮换分片。

## 格式与还原

每行是 JSON，`type=model-request-diagnostic`、`version=2`，包含 Relay 协议版本、`recordedAt`、事件 ID、请求 ID、连接 ID、任务/回合、模型、端点及完整上游 URL。单个请求按 `requestId` 关联，WebSocket 请求通过 `connectionId` 关联握手，通过 `streamId`/响应 ID 关联消息。任务上下文缺失时保留 null，不从其他任务猜测；生命周期分析仍兼容 version 1 原始记录。

| phase | 含义 |
| --- | --- |
| `request` | 请求开始；`headers`、解码后的 `body`（可用时）和原始 `bodyBase64` |
| `request-headers` | Node HTTP 客户端的请求头，含自动补充的 Host；WebSocket 含握手头 |
| `response-headers` | 上游真实 `httpStatusCode`、完整 `headers`、`rawHeaders` |
| `body-chunk` | `direction`、二进制标记及 `dataBase64` 原始字节 |
| `response-envelope` | 辅助索引：state 字段路径、长度、SHA-256，协议数值字段、响应状态/模型/ID |
| `error` | 连接或流错误的原始 code/message |
| `finished` | 正常结束、中止、错误或连接关闭；汇总检查状态和耗时 |

HTTP 请求将 `bodyBase64` 做 Base64 解码即可还原实际转发字节。`body` 是可解析的客户端 JSON，可能与自定义模型经过改写后的字节不同，**线上字节以 `bodyBase64` 为准**。HTTP 响应按同一请求的事件顺序拼接 `direction=response` 的 `dataBase64`，然后按 `Content-Encoding` 解压；这保留完整压缩流。WebSocket 的每个 `body-chunk` 是 ws 解码后的完整消息，不是 TCP 包或压缩、掩码后的底层帧。

只查看状态而不输出原文：

```sh
jq -c 'select(.phase == "response-headers" or .phase == "finished") | {recordedAt,requestId,connectionId,threadId,turnId,model,transport,httpStatusCode,outcome,responseStateFields,envelopeCodes}' model-request-diagnostics.jsonl
```

辅助 JSON/SSE 检查每帧上限为 256 Ki 字符，只读取信封字段，不扫描输入、输出和工具正文。超限、格式未知或解析失败标记 `bodyInspection=partial`；**此上限只影响索引，原始字节仍完整保存**。`not-observed` 表示没有解析到信封，不能推断 state 不存在。中止只能保存已收到的内容，不能补回服务端尚未发送的内容。

生成不包含 state 原值、请求正文或凭据的生命周期报告：

```sh
npm run analyze:requests -- --path="<数据目录>/model-request-diagnostics.jsonl" --thread=<任务ID> --output=.runtime/analysis/state-lifecycle.json
```

报告按连接、请求和回合关联 `x-codex-turn-state`，只输出字段路径、字符/字节长度和完整 SHA-256。`replayObserved=false` 只表示捕获范围内没有看到同一值进入后续请求，不能解释成客户端拒绝回传；同一 WebSocket 未重连时通常没有新的握手头可观察。

HTTP 200、292、312 必须取 `response-headers.httpStatusCode`。WebSocket 握手通常是 101，后续生成没有独立 HTTP 响应码，其 `httpStatusCode=null` 是正确语义。消息体中的 292/312 记为 `envelopeCodes`，不能混同 HTTP 状态，也不能据此自动宣布“降智”。state 出现只证明字段存在，不验证有效期或服务端含义。

## 生效条件

Widget 刷新不会替换已经加载的 Relay/Router。新的源码或构建产物不等于日常客户端已启用新行为。需通过正常更新流程加载 Relay 协议 90；如需全量记录，还必须在启动环境显式设置上述开关，再检查该文件出现新任务的 `request`、`response-headers`/消息和 `finished`。

本次分析开始时日常 WSL Relay 为 0.1.290 / 协议 88，已经保存完整原文；新增的索引、轮换和权限警告属于 0.1.291 / 协议 89，未获得重启授权前不关闭、重连或接管当前 Relay。生命周期报告可以直接分析 0.1.290 的原始日志，不需要重启。
