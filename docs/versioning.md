# 版本号更新规则

- 项目有 3 个需要随功能改动判断是否升级的主版本号：
  1. 应用发布版本：`package.json` 与 `package-lock.json` 中的 `version`，两处必须一致。任何准备提交的代码、配置或文档改动都必须升级；默认递增补丁版本。
  2. 页面注入运行时版本：`src/widget/contract.mjs` 定义、`src/widget.mjs` 对外导出的 `WIDGET_RUNTIME_VERSION`。只要注入页面的 DOM、样式、交互、展示数据或事件处理发生变化就必须升级；纯后端、中继或文档改动不升级。
  3. 中继协议版本：`src/relay-contract.mjs` 中的 `RELAY_PROTOCOL_VERSION`。只要中继启动契约、模型目录、供应商路由、请求/响应改写、模型能力映射或用量事件协议发生变化就必须升级，以触发 Codex app-server 使用新协议重启；纯页面、计价或注入器外围逻辑改动不升级。
- 本地数据和缓存还各自有内部结构版本，例如 `STORE_VERSION`、`CACHE_VERSION`、`COST_CACHE_VERSION`、`ROLLOUT_PARSER_VERSION`、`RELAY_CONFIG_VERSION`。新增、删除、重命名持久化字段，改变缓存内容语义、解析结果语义或配置文件契约时，必须升级对应版本；仅修改兼容旧结构的运行逻辑时不升级。内部结构版本不替代应用发布版本。
- `MODEL_CAPABILITY_PROBE_VERSION` 是模型能力检测结果的缓存契约版本。只有探测结论语义改变，或已有缓存可能被新规则证明为不可信时才升级；页面展示、进度、重试策略、测试编排、文档和不改变结论的内部重构不得升级。版本升级后的旧结果必须明确显示为“检测规则已更新”，不得伪装成从未检测，也不得在重启时未经当次授权自动消耗 Token 重新检测。
- 模型目录中的 `minimal_client_version`、`multi_agent_version` 等字段属于 Codex 模型能力契约，不是本项目发布版本；只有对应能力契约确实变化时才修改，不能用于标记本项目发版。

提交前核对上述版本；GitHub 安装包文件名、Release 标签和标题均使用应用发布版本。
