# 北辰模型与官方账号同步 · 2026-10-22

## 同步内容

北辰后端、学生页及能力配置更新为v2.11.0，私有服务工作台更新为v1.7。

| 内容 | 当前范围 |
| --- | --- |
| 文字模型目录 | 15组服务，154个模型选项 |
| 官方账号 | 研究台已有的两个ChatGPT／OpenAI OAuth账号，共享云端授权池 |
| 官方模型 | GPT-6.1-Sol、GPT-6-Astra、GPT-6-Sol、GPT-6-Luna、GPT-5.6-Sol／Terra／Luna、GPT-5.5 |
| 新补齐入口 | 官方OAuth、Kimi K3／K2.8、两组原生Gemini、ByteCat Grok、猎豹新增GPT与DeepSeek型号 |
| 原生强度 | 按模型能力提供low／medium／high／xhigh／max／ultra或auto等实际支持的档位 |
| 速度参考 | 复制研究台已有TPS、来源页面和采集日期，作为历史参考展示 |
| 生图目录 | ByteCat Image 2、猎豹Image 2原生、猎豹Image 2.5、猎豹旧Image 2接口，共4组；缺少凭据的旧接口保留未配置状态 |

生图通道独立保存配置。北辰当前没有自动插图流程，现有选科对话与星图报告继续使用文字模型；同步生图配置不表示报告会自动调用这些接口。

目录来源是[研究台提交a8dc667](https://github.com/yusheng266186-beep/jianwei-observatory/tree/a8dc667e9e08996d94389d65d1ea079083776b85)，来源与数量记录在[model-sync.json](../model-sync.json)。同一模型在不同提供方下是独立配置，套餐权限和余额仍以各上游真实结果为准。

## 两个官方账号如何共用

北辰沿用研究台的官方账号控制源码和同一个COS授权控制前缀，不另存一份独立刷新令牌。跨实例租约涵盖两站，同一个账号刷新和调用时会互斥；刷新后的记录供两站继续使用。北辰单独保存 `OPENAI_CODEX_ACCOUNT_ID`，不修改研究台账号池的当前选择。两站调用使用同一个官方账号时，共享该账号的实际额度。

工作台在官方服务下显示账号选择，支持独立应用“账号＋模型＋档位”。新增授权或需要重新授权时，从工作台的管理链接进入既有授权页完成操作。浏览器、公开仓库和工作台状态文件不会收到OAuth令牌。

复制的共享模块位于[official/](../official/SOURCE.json)，逐文件SHA-256锁定源提交；北辰适配器位于[official-chat.js](../official-chat.js)。系统指令和全部用户／助理原话保留，官方运行时接收完整角色记录，不为接入删短对话或变更报告题材要求。官方公开思考摘要与正文转换为原页面可消费的SSE，失败不发送成功终态，也不结算星图次数。

## 模型协议与后台操作

- Gemini使用原生 `systemInstruction`、多轮 `contents` 和 `thinkingConfig`；流式正文、公开摘要、停止或截断状态转换为统一SSE。
- Kimi按实际支持的low／high／max执行，K2.8使用上游现有 `kimi-for-coding` 标识；不伪造其他型号或档位。
- Claude、Responses与Chat Completions保留原生适配。非自适应Claude的新增原生档位会生成有效的整数思考预算。
- 模型目录由固定同步快照呈现，旧缓存和供应商列表差异不会静默删掉新增型号。选中后仍核验候选模型，再更新云端配置并回读。
- 私有工作台通过现有GitHub Actions管理；新增的 `/maintenance/accounts`、`/maintenance/probe` 只接受服务端HMAC签名、有效时间和不可重放nonce。调用只返回脱敏账号信息，或执行固定37×19探测，不开放任意免鉴权聊天。
- 官方模型只核验所选档位，避免无条件再跑一次最高档。已完成验证的缓存还绑定账号ID，换账号不会误复用另一账号的成功记录。
- 默认原生档位对没有个人偏好的学生生效；已有省时／标准／深思设置继续生效。

## 部署与后续维护

现行函数仍为 `beichen-qianfan-mini`，保留原公网地址、VPC、256MB内存、600秒超时及每实例1并发。现有Node16镜像不能原地修改；[runtime-compat.js](../runtime-compat.js)补充授权控制所需的对象克隆和组合取消信号，官方模块本身保持原字节。本地开发及CI推荐Node20。

新增组件层为 `beichen-openai-codex:1` 与 `beichen-openai-xray:1`，使用研究台已经验证的同一份二进制归档，仅增加适用运行时声明。研究台原层与函数不变。启动脚本按既有方式加载执行文件；代理出站配置与研究台当前配置相同。

函数角色 `BeichenOfficialAccountRole` 仅能读写共享桶中的 `training-control-v1/openai-codex/*`，不授予成绩材料和普通训练任务的存储权限。新增的 `BEICHEN_WORKBENCH_SECRET` 只用于私有维护请求，由Actions从函数环境读取；不写入HTML。API密钥只同步到函数环境，没有写入公开提交。

后续可在研究台源码更新后执行：

```bash
node tools/sync-observatory-models.cjs /本地/jianwei-observatory
npm ci
npm run verify
node tools/package-backend.cjs /仓库外安全目录/beichen-backend.zip
```

同步工具只复制公开目录、协议、性能参考与官方控制源码，不读取云端密钥或本机账号。升级后还需将适配文件同步至私有工作台工具、重新生成HTML、测试并发布；复制目录本身不执行云端配置变更。部署时备份原函数、保留Redis与学生验证码配置，并核对真实云端结果。

## 验证

新增回归覆盖全部154个型号与档位参数、原始源码哈希、Node16兼容、Gemini UTF-8流、完整对话传递、账号固定、取消与SSE终态、HMAC过期／篡改／重放，以及工作台账号和生图配置独立性。本轮没有开启或重建Redis。云端代码归档1117个文件逐字核验通过，当前聊天模型、默认强度、VPC、Redis与学生验证码配置保持。

真实固定题目37×19探测共8项：两个官方账号的Sol6.1／high分别12.9秒和12.6秒完成；Kimi K3／K2.8、ByteCat Gemini、Grok与当前猎豹GPT-6 Sol也完成，共7项成功。接口探测用于验证接线和协议，不代表选科报告质量评测。

猎豹Gemini两次分别约126秒、100秒失败。后一次诊断直接记录上游HTTP502、`text/plain`，确认不是北辰JSON／SSE转换拒收；该型号保留在目录，切换验证失败时不会覆盖当前配置。另补齐合法Gemini完整JSON或JSON数组到SSE的兼容，避免仅因上游未标成SSE而误拒绝有效成稿。

自动测试覆盖65项后端／页面检查（本地2项依赖独立Redis的检查由CI运行）、50项维护工具测试及7项后台界面测试；源码扫描和HTML语法检查通过。工作台新HTML需从私有v1.7发行包更新，旧下载文件不会自动增加账号和新档位控件。
