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

自 v2.9.3 起，所有聊天、星图、格式修复和续写都在前端统一分段校验，长对话保留有角色标注的完整原文。原生参数、三档预算及模型能力版本继续为 v2.9.1。详见 [对话完整性](docs/对话完整性与流程修复-v2.9.3.md)。

## v2.10.0 多接口适配

供应商白名单和非秘密地址见 `api-providers.json`；同名模型的协议及能力按供应商隔离，见 `model-profiles.json` 的 `providers`。模型数据来自本机 DSH 的已配置目录；DeepSeek 与原 Wefucke 模型保留已验证的预算和映射。

新增 ByteCat 新CC 和原CC各 8 个 Claude 模型、GPT 组 9 个模型，另同步 Wefucke GLM／Muse、GPT、Command Code 两种接口及千帆目录。共 133 个中转模型项，另保留 DeepSeek 官方 2 项。同一模型在不同 API 下是独立配置。

Claude 使用 Messages 的 system、thinking 与 output_config；GPT 组使用 Responses 的完整 input、store:false 和 reasoning。不支持 Max 的模型展示其最高原生档位；没有可调档位的别名由供应商决定思考方式，三档仅调整输出预算。未知上游能力不伪造 Max。Responses 的输出预算包括正文与推理，按模型保留足够预算；[参数依据](https://developers.openai.com/api/reference/resources/responses/methods/create)、[迁移格式](https://developers.openai.com/api/docs/guides/migrate-to-responses)。

`upstream-stream.js` 只转换格式，逐字保留输出；终态重复正文不重复拼接，输出上限仍转换成 length，便于原星图生成流程继续补全。流中报错、缺终态、终态正文与增量不一致均按失败处理。完整历史与报告提示不截短；学生页的格式修复、接续生成、质量门与成功结算保持。

工作台使用同一份 Node 适配器及流转换器验证目标模型，验证缓存绑定协议、密钥、地址、参数和能力版本，失败保留当前配置。Command Code／千帆套餐或余额限制、GPT-5.4 Compact 的上游过载由切换前实测拦截，不自动换到其他模型。
