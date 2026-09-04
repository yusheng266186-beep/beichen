# 北辰 · 高一选科探索（POLARIS）

> 譬彼北辰，居其所而众星共之。——《论语·为政》

「北辰」是一款面向高一学生的 AI 选科陪伴网页。它不从"哪个组合更热门"开始，而是通过一场一对一的深度谈心，陪学生回看学科手感、开窍与挫败、真正的热爱、理想生活、身边的声音与现实的取舍，最终点亮一张专属的「北辰星图」：文理方位与星值、五张贴着个人影子的星卡、可参考的 3+1+2 组合、对口专业解析，以及一段写给学生本人的寄语。

- **在线使用**：<https://yusheng266186-beep.github.io/beichen/>（星门需输入向维护者获取的 6 位动态验证码）
- **旧版（v1）存档**：<https://yusheng266186-beep.github.io/beichen/legacy/index-v1.html>（代码原样保留于 `legacy/`，仍可访问）
- **发布页**：<https://github.com/yusheng266186-beep/beichen/releases>


## 本次迭代先看这里

本次是前后端对齐迭代：后端版本 **v2.7.0-stateful**，页面版本 **v2.6.20**。本次只改动后端变化确实需要同步的部分：验证提醒、后端版本标记、设置页的真实就绪检查和对应错误提示；原有聊天界面、提示词、样式、解析器及其他无关交互保持不变。

详细的版本、部署和验收记录见 [CHANGELOG.md](CHANGELOG.md)，正式发行版见 [v2.7.0-stateful Release](https://github.com/yusheng266186-beep/beichen/releases/tag/v2.7.0-stateful)。

这次改动只围绕“密钥保护下的会话和次数”展开：

1. TOTP 动态码的使用记录、会话、次数和重复提交收据统一放进共享 Redis，不再只放在某一个函数实例的内存里。
2. 普通聊天先占一个临时位置，千帆正常结束才记一轮；超时、失败或用户中断会释放这个位置。
3. 星图生成先占住一个可结算位置，只有生成成功并收到原来的 `/run/complete` 确认才扣一次完整次数。
4. 同一个 `X-Request-ID` 永远只结算一次。旧票据、新票据或网络重试都只拿到第一次的结果。
5. Redis 不可用时服务会拒绝新请求，不会偷偷退回单机内存，从而避免多实例之间出现各算各的次数。

页面原有的三种请求格式不需要改变：普通聊天使用 `max_tokens=5000`，星图使用 `max_tokens=16384`，确认请求使用空 JSON 加 `X-Request-ID`。后端会把高预算请求作为星图请求处理，并限制修复尝试次数；本次页面同步只补上状态检查和提示，不改聊天请求流程。

---

## 功能特性

### 两种聊法

| 模式 | 适合 | 体验 |
| --- | --- | --- |
| **夜航**（Wander） | 愿意多说、想被认真听的学生 | 没有选项、不下框架；第 5 轮起每轮实时评估画像成熟度，认为足够时给出「点亮星图」入口，满 15 轮固定给出；轮数不设上限（服务端单会话总轮数兜底） |
| **领航**（Guided） | 不知道说什么、想要引导的学生 | 每轮给出思考扶手与 4 个具体选项，满十轮自动点亮星图；生成失败只走「重新点亮星图」按钮重试，不逐轮静默重试、不重复扣额度 |

### 北辰星图

- **文理方位与星值**：刻度轴可视化方向倾向；线索冲突时如实标注"仍在观察"，不假装精确；
- **五张星卡**：学科底色 / 思维与学习 / 热爱与职业 / 决策工具透视（黄金三角 × 霍兰德 RIASEC × SWOT 逐一对照）/ 盲区叮嘱，全部融汇谈心中的具体细节；
- **3+1+2 组合推荐**：首选 + 备选，附理由与专业覆盖率参考；
- **专业方向解析**：5–8 个方向，点击弹出悬浮卡，每项含推荐分析（结合对话线索与选科衔接）与就业方向（行业 / 典型职业 / 升学路径）；
- **宽容解析器**：星图字段缺失逐级降级渲染、口语缩写组合自动归一，绝不死循环；彻底无效时只做一次有界格式修复。

### 等待体验

- 深思考过程以**思考低语**实时上屏（仅显示、不落历史、不上传）；
- 网关不流思考增量时，以叙述文案轮播兜底，等待不黑箱；
- 星图轮的前置回应实时流式上屏，并按字段分段提示进度。

### 数据参考

四川 2025–2026 招录测算、十二组合速查、黄金三角 / 霍兰德 RIASEC / SWOT 三个决策工具、常见疑问 FAQ（事实类内容两源交叉验证后收录）。

---

## 架构与安全模型

```
学生浏览器（GitHub Pages，前端零密钥）
   │  POST /verify · /run/complete · /chat/completions（SSE 流式）
   ▼
腾讯云 SCF Web Function（beichen-qianfan-mini，本仓库 scf-relay.js）
   │  Bearer 千帆 Key（仅存云端环境变量）
   ▼
百度千帆 Token Plan 个人版专属端点 · qianfan-code-latest（深度思考 max）
```

| 机制 | 说明 |
| --- | --- |
| 星门（2FA） | TOTP 动态码（6 位，SHA1/30s，±1 窗口兜底，一次性消费防重放）→ 换取 7 天 HMAC 签名会话票据；票据仅存本机 localStorage，重新验证自动覆盖，过期或"清除本机记录"后失效 |
| 额度纪律 | 一次验证 3 次完整谈心（以星图生成为计）；`/run/complete` 以 `X-Request-Id` 幂等记账，网络重试不重复扣额；星图档请求在额度用尽后被服务端直接拒绝（防绕过记账）；单会话总轮数上限兜底 |
| 模型参数 | 模型名、思考档位（max）、思考预算分档（星图轮 4096 / 日常轮 2048，环境变量可覆盖且互不污染）全部由服务端固定，客户端不可指定 |
| 上游边界 | 千帆端点白名单（仅个人版专属端点，coding 系一律拒绝）、上游超时、响应体上限、SSE 背压 |
| 浏览器边界 | 严格 CSP（脚本零第三方，截图组件自托管）、CORS 仅放行 Pages 主域、全部响应 no-store 与安全响应头 |
| 共享状态 | 动态码消费、会话、次数预占/释放、星图结算和重复请求收据统一写入共享 Redis；Redis 不可用时不降级到单机内存 |
| 隐私 | 对话与思考内容不落库、无第三方统计；云函数不打印请求内容 |


## 接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `POST` | `/verify` | 提交 `{ "code": "六位数字" }`，返回 HMAC 会话票据 |
| `POST` | `/chat/completions` | 提交现有页面格式的流式聊天请求 |
| `POST` | `/run/complete` | 提交空 JSON 与 `X-Request-ID`，确认一张已成功生成的星图 |
| `GET` | `/healthz` | 存活检查，不需要密钥；返回后端和页面版本标记 |
| `GET` | `/readyz` | 检查后端配置、Redis 和上游配置是否就绪；设置页用它判断连接结果 |

`/run/complete` 不接受“是否扣次数”或“增加几次”之类的客户端字段。它只接受空对象，是否可以结算、结算几次完全由服务端状态决定。

---

## 部署

新手向完整步骤（含 zip 打包两条铁律：LF 换行 + 755 可执行位）见 **[beginner-deploy.md](beginner-deploy.md)**。概要：

1. 腾讯云创建 Web Function（Nodejs18/20 优先），上传 `scf-relay.js + scf_bootstrap`，在加密环境变量中填写密钥（仓库不含任何真实密钥）；
2. GitHub 仓库启用 Pages（main 分支根目录），前端零配置即可连云函数（CORS 按主域放行）；
3. 更新云函数前务必阅读 `beginner-deploy.md` 的"更新会重启实例、清空内存会话"警告。

### 本次生产部署（2026-09-04）

本次版本已完成腾讯云实际部署，沿用现有云函数、Redis 和网络资源，没有另外创建第二套资源。新版部署包需要把 Redis 运行依赖一起带上：

~~~bash
npm ci --omit=dev
~~~

上传包至少包含：

~~~text
scf-relay.js
state-store.js
scf_bootstrap
package.json
package-lock.json
node_modules/
~~~

生产状态使用 `STATE_STORE=redis`。Redis 地址可以使用 `REDIS_URL`，也可以分别填写 `REDIS_HOST`、`REDIS_PORT`、`REDIS_USERNAME`、`REDIS_PASSWORD` 和 `REDIS_TLS`；真实值只填入腾讯云环境变量，不能写入仓库。

远程部署完成后，生产函数的 `/readyz` 实测结果为：

| 检查项目 | 实际结果 |
| --- | --- |
| HTTP 状态 | `200` |
| 服务就绪 | `ready: true` |
| 后端配置 | `providerConfigured: true` |
| 状态保存 | `stateStore: redis` |
| Redis 连接 | `stateStoreReachable: true` |
| 后端版本 | `v2.7.0-stateful` |
| 页面版本 | `v2.6.20` |

此前“中转服务未就绪”的直接原因是部署检查脚本错误依赖腾讯云返回的 `CodeSize` 字段。函数已经进入运行状态，但该字段为空或为 0，脚本因此误报超时；现已改为根据函数进入 `Active` 或 `Running` 判断部署完成。

## 本地开发

```bash
node --test tests/*.test.js   # 三套契约测试全绿为基线（parse / index-contract / relay-contract）
```

- `parse.test.js`：星图宽容解析回归（6 场景，覆盖历史死循环案例）；
- `index-contract.test.js`：前端结构与行为锁（双聊法、两段式契约、安全接线、动效系统、版本标记等，按版本分块）；
- `relay-contract.test.js`：服务端契约（思考预算分档、端点白名单、请求校验、额度纪律、真实 IP 取尾）。

新增行为必须先加测试锁再合入。

当前状态层相关测试还包括：

- `tests/relay-integration.test.js`：验证现有页面请求格式下的验证、普通轮回退、星图结算与幂等重试；
- `tests/state-store.test.js`：验证并发预占、失败释放、修复恢复和单次结算。

完整本地检查：

~~~bash
npm ci
npm run verify
~~~

## 目录结构

| 路径 | 说明 |
| --- | --- |
| `index.html` | 唯一前端页面（单文件内联 CSS+JS：星门 / 序章 / 选聊法 / 双模式谈心 / 星图 / 数据参考 / 设置），设置面板可见版本号 |
| `scf-relay.js` | 云函数唯一入口（验证 / 额度 / 转发 / 边界），生产运行时以环境变量持钥，并通过共享 Redis 保存关键状态 |
| `scf_bootstrap` | SCF 启动脚本（node 二进制运行时自检；`.gitattributes` 锁定 LF） |
| `state-store.js` | Redis 生产实现与内存测试实现；关键操作使用 Redis Lua 原子脚本 |
| `package.json` / `package-lock.json` | Redis 运行依赖和可重复安装锁文件 |
| `tests/` | 前端、解析器、中转服务与状态层测试 |
| `fonts/` | Noto Serif SC / Cormorant Garamond 自托管分片（主源为 Google Fonts 大陆边缘，加载失败自动回退本目录） |
| `vendor/` | 自托管 html2canvas（截图组件，零第三方运行时依赖） |
| `legacy/` | v1 旧版原样存档（`legacy-v1` 标签指向并入前状态） |
| `archive/` | 早期调试库原样存档（`archive/*` 标签指向各自仓库终态） |

## 版本与历史

- 当前生产版本：后端 **v2.7.0-stateful**，页面 **v2.6.20**；
- 上一份正式 Release 为 **v2.6.18**；页面版本仍在 `index.html` 的 `APP_VERSION` 与设置面板同步展示；
- 本次详细更新记录见 [CHANGELOG.md](CHANGELOG.md)，正式发行版见 [Releases](https://github.com/yusheng266186-beep/beichen/releases/tag/v2.7.0-stateful)；
- v2 重构版（v2.6.x，30+ 次迭代提交）于 2026-08-29 自调试库整体并入本仓库，`git log` 可完整回溯每一步的动机与实现；
- v1 旧版见 `legacy/` 与 `legacy-v1` 标签；早期私有调试库见 `archive/` 与 `archive/*` 标签；
- 历史发布与变更说明见 [Releases](https://github.com/yusheng266186-beep/beichen/releases)。

## 维护

- 维护者：予笙（页面"设置 → 写给你"内有联系方式）
- 动态验证码按需发放；TOTP 种子、云函数密钥等敏感凭据仅存于维护者本地交棒文档，**永不入库**（`.gitignore` 已硬性排除）。
- 本次部署所需的真实配置只从受控的私有交接材料读取，未写入正式仓库、README、发行版说明或日志。

## 免责声明

北辰的星图与数据参考仅为探索辅助，**正式选科以本省教育考试院政策与高校招生章程为准**。
