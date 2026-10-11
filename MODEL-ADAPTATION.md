# 北辰模型适配 v2.9.1

模型切换需要原生参数、输出预算、流式完整性与星图解析同时适配。模型能力配置位于 `model-profiles.json`；私有工作台工具使用同版本副本。

| 模型 | 省时 | 标准 | 深思 |
| --- | --- | --- | --- |
| DeepSeek Flash / V4 Pro | low | high | max |
| GLM 5.3 / 5.3 Flash | low | high | max |
| GLM 5.2 | high | high | max |
| GLM 5.1 | 自动 | 自动 | 自动 |
| GPT 5.5 | low | high | xhigh |
| GPT 5.6 / 5.6 Sol / 5.6 Terra / 6 Sol | low | high | max |

GLM 5.1 不支持原生强度控制；其三档只改变输出预算。GLM 5.2 把 low 映射成 high。未适配的模型可以显示在发现列表，但不能切换上线。

GPT 使用 `max_completion_tokens` 和 `reasoning_effort`，移除其他供应商思考字段和不兼容的 temperature。DeepSeek 使用 `thinking`、`reasoning_effort` 和 `max_tokens`；GLM 使用原生 thinking / reasoning_effort，不再依赖通用 reasoning 对象。历史仅保留可见对话，GLM 明确 clear_thinking=true。

客户端 max_tokens 保留普通轮与报告档的额度分类含义。上游普通轮预算为 8192 / 16384 / 32768，星图为 32768 / 49152 / 65536，包含推理和正文；这是上限，实际计费按使用量。

SSE 必须有可见回答和 [DONE]，内嵌错误、畸形事件、意外 EOF 不计为成功；length 最多续写两次，仍截断则不进入报告完成流程。星图允许专业换行或重复标签，但计次前要求五张卡、两个不同合法组合、5–8 个有分析和就业方向的专业；不完整先进行一次修复，仍不完整只作预览而不结算报告次数。

工作台首次切换或验证失效时，实测所选档与最高档的完整 SSE；六小时内的有效验证可复用，签名绑定密钥、服务地址、原生参数与适配版本。真实切换仍核验上游连通，失败保留旧配置，生效后回读健康检查能力版本。工作台的默认强度用于未设置过强度的客户端，学生可自行调整。

文档依据：[DeepSeek](https://api-docs.deepseek.com/guides/thinking_mode/)、[GLM](https://docs.z.ai/api-reference/llm/chat-completion)、[GPT-6 Sol](https://developers.openai.com/api/docs/models/gpt-6-sol)、[Chat Completions 参数](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)。
