# 2026-11-18 GPT-6.2 计价定向验证

macOS 原生 arm64，Node v26.13.1，工作区版本 0.1.347。免费回归中的公共计价、历史用量重算和模拟唤醒选模用例共 22 项通过，0 失败，0 跳过。原始输出保存在本机 `.runtime/test-results/2026-11-18-pricing-targeted.tap`。

执行命令为 `node --test --test-concurrency=1 test/token-pricing.test.mjs test/token-usage-pricing-refresh.test.mjs test/wakeup-client.test.mjs`。

- GPT-6.2 Sol、Astra 和 Astra Law 的短、长上下文分别核对普通输入、缓存命中、30 分钟缓存写入、输出及总费用。[OpenAI Standard 价目](https://developers.openai.com/api/docs/pricing)
- Sol 和 Astra 的两个短请求从旧用量记录恢复后，即使合计输入超过 272,000 Token，仍按各自短价计算本轮和累计费用。
- 唤醒选模运行于模拟账号和模型目录。本轮真实模型测试请求为零。
- 日常运行的是已安装的 0.1.346 正式包，计价代码随 Worker 打包。验证结果对应工作区源码。
