# 北辰 · 高一选科探索（POLARIS）

> 譬彼北辰，居其所而众星共之。——《论语·为政》

「北辰」是一款面向高一学生的 AI 选科陪伴网页。它通过一场一对一的深度谈心，陪学生回看学科手感、开窍与挫败、真正的热爱、理想生活、身边的声音与现实的取舍，最后生成专属的「北辰星图」。

- 在线使用：<https://yusheng266186-beep.github.io/beichen/>
- 旧版（v1）存档：<https://yusheng266186-beep.github.io/beichen/legacy/index-v1.html>
- 发布页：<https://github.com/yusheng266186-beep/beichen/releases>

## 本次迭代先看这里

本次是前后端对齐迭代：后端版本 **v2.7.0-stateful**，页面版本 **v2.6.20**。页面只改动了后端变化确实需要同步的部分：验证提醒、后端版本标记、设置页的真实就绪检查和对应错误提示；聊天界面、提示词、样式、解析器及其他无关交互保持不变。

完整的版本变更、故障排查、实际部署和验收记录见 [CHANGELOG.md](CHANGELOG.md)。

这次改动只围绕“秘钥保护下的会话和次数”展开：

1. TOTP 动态码的使用记录、会话、次数和重复提交收据统一放进共享 Redis，不再只放在某一个函数实例的内存里。
2. 普通聊天先占一个临时位置，千帆正常结束才记一轮；超时、失败或用户中断会释放这个位置。
3. 星图生成先占住一个可结算位置，只有生成成功并收到原来的 `/run/complete` 确认才扣一次完整次数。
4. 同一个 `X-Request-ID` 永远只结算一次。旧票据、新票据或网络重试都只拿到第一次的结果。
5. Redis 不可用时服务会拒绝新请求，不会偷偷退回单机内存，从而避免多实例之间出现各算各的次数。

6. 设置页的“检查连接”改为读取后端 `/readyz`：只有共享次数记录、验证配置和上游配置都已就绪，页面才显示“正常”；如果页面和后端版本不一致，也会明确提示“需同步”。

页面原有的三种请求格式不需要改变：普通聊天使用 `max_tokens=5000`，星图使用 `max_tokens=16384`，确认请求使用空 JSON 加 `X-Request-ID`。后端会把高预算请求作为星图请求处理，并限制修复尝试次数；本次页面同步只补上状态检查和提示，不改聊天请求流程。

## 功能

### 两种聊法

| 模式 | 适合 | 体验 |
| --- | --- | --- |
| 夜航（Wander） | 愿意多说、想被认真听的学生 | 没有选项，不下框架；服务端用单会话总轮数兜底 |
| 领航（Guided） | 不知道说什么、想要引导的学生 | 每轮提供思考扶手与具体选项，满足条件后点亮星图 |

### 北辰星图

- 文理方位与星值：展示方向倾向，线索冲突时标注“仍在观察”；
- 五张星卡：学科底色、思维与学习、热爱与职业、决策工具透视、盲区叮嘱；
- 3+1+2 组合推荐：首选与备选并列给出理由和专业覆盖率参考；
- 专业方向解析：结合谈心线索展示推荐分析、行业、职业与升学路径；
- 宽容解析器：字段缺失时降级渲染，无效格式最多进行一次有界修复。

## 架构与安全边界

```text
学生浏览器（GitHub Pages，前端不保存任何秘钥）
       │  /verify · /chat/completions · /run/complete
       ▼
腾讯云 SCF Web Function（scf-relay.js）
       │  会话/次数/TOTP/收据 → 共享 Redis
       │  千帆 API Key → 百度千帆 Token Plan 个人版端点
       ▼
百度千帆 · qianfan-code-latest
```

### 三个关键流程

| 流程 | 服务端行为 |
| --- | --- |
| 验证 | 用 `GATE_TOTP_SECRET` 校验 6 位动态码，用共享存储一次性消费当前验证码，再用 `GATE_SESSION_SECRET` 签发 7 天 HMAC 票据 |
| 普通聊天 | 在 Redis 里创建带到期时间的临时预占；成功结束后增加轮数，失败/超时/中断释放预占 |
| 星图与结算 | 高预算请求先占用一个星图位置；生成成功进入待确认状态；`/run/complete` 在 Redis 原子操作中校验当前票据、增加次数、旋转票据并保存收据 |

### 保留的环境变量接口

以下变量名称保持不变，真实值只放在腾讯云的加密环境变量中：

- `GATE_TOTP_SECRET`：动态验证码应用使用的 Base32 seed；
- `GATE_SESSION_SECRET`：至少 32 字节的会话签名密钥；
- `QIANFAN_API_KEY`：千帆 Token Plan 个人版 Mini 专属 API Key；
- `QIANFAN_BASE_URL`：默认是 `https://qianfan.baidubce.com/v2/tokenplan/personal`；
- `QIANFAN_MODEL`：默认 `qianfan-code-latest`。

新增的状态配置见 [.env.example](.env.example)。其中 `STATE_STORE=redis` 是生产值；`STATE_STORE=memory` 只供本地测试使用，不能作为 Redis 故障备份。

### 上游与浏览器边界

- 只允许 `qianfan.baidubce.com` 的 Token Plan 个人版专属地址；
- 模型名、深度思考档位和预算由服务端固定，客户端不能传入模型；
- 请求体最多 128 KiB，提示词默认最多 40000 个字符，响应最多 2 MiB；
- SSE 流支持背压，单次上游超时默认 540 秒；
- CORS 只放行 Pages 主域，响应带 `no-store` 和安全响应头；
- 对话正文和思考过程不写入 Redis，也不写进日志；Redis 中只保留短期会话状态、次数状态和结算收据。

## 接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `POST` | `/verify` | 提交 `{ "code": "六位数字" }`，返回 HMAC 会话票据 |
| `POST` | `/chat/completions` | 提交现有页面格式的流式聊天请求 |
| `POST` | `/run/complete` | 提交空 JSON 与 `X-Request-ID`，确认一张已成功生成的星图 |
| `GET` | `/healthz` | 存活检查，不需要秘钥；返回后端和页面版本标记 |
| `GET` | `/readyz` | 检查秘钥配置、Redis 和上游配置是否就绪；设置页用它判断“检查连接”结果 |

`/run/complete` 不接受“是否扣次数”或“增加几次”之类的客户端字段。它只接受空对象，是否可以结算、结算几次完全由服务端状态决定。

## 部署

完整的新手步骤见 **[beginner-deploy.md](beginner-deploy.md)**。新版部署包不再只有两个文件，需要把运行依赖一起带上：

```bash
npm ci --omit=dev
```

上传包至少包含：

```text
scf-relay.js
state-store.js
scf_bootstrap
package.json
package-lock.json
node_modules/
```

腾讯云环境变量至少需要配置：

```text
STATE_STORE=redis
REDIS_URL=你的 Redis 内网地址
BEICHEN_REDIS_PREFIX=beichen:v27
QIANFAN_API_KEY=（真实值只填云端）
QIANFAN_BASE_URL=https://qianfan.baidubce.com/v2/tokenplan/personal
QIANFAN_MODEL=qianfan-code-latest
GATE_TOTP_SECRET=（真实值只填云端）
GATE_SESSION_SECRET=（真实值只填云端）
CORS_ALLOWED_ORIGINS=https://yusheng266186-beep.github.io
PORT=9000
```

Redis 和 SCF 必须网络互通；Redis 地址、密码和 TLS 方式按所用托管服务填写。不要把这些真实值写入仓库、Issue、日志、截图或聊天记录。

部署后先访问 `/healthz` 和 `/readyz`。只有 `/readyz` 返回 `ready: true`，再打开网页验证动态码。页面进入设置后点击“检查连接”，应看到“正常”，并且版本摘要应为后端 `v2.7.0-stateful`、页面 `v2.6.20`。如果看到“需同步”，说明页面或函数仍有一方没有更新。只有迁移到另一套云函数时，才按部署指南同步替换页面里的函数地址和 CSP 域名。

### 最近一次生产验收（2026-09-04）

本次版本已完成腾讯云实际部署，沿用现有云函数、Redis 和网络资源，没有新增第二套资源。远程部署后直接检查生产函数的 `/readyz`，结果为：

| 检查项目 | 实际结果 |
| --- | --- |
| HTTP 状态 | `200` |
| 服务就绪 | `ready: true` |
| 后端配置 | `providerConfigured: true` |
| 状态保存 | `stateStore: redis` |
| Redis 连接 | `stateStoreReachable: true` |
| 后端版本 | `v2.7.0-stateful` |
| 页面版本 | `v2.6.20` |

此前“中转服务未就绪”的直接原因是部署脚本错误依赖腾讯云返回的 `CodeSize` 字段。函数已经进入运行状态，但该字段为空或为 0，脚本因此误报超时；现已改为根据函数进入 `Active` 或 `Running` 判断部署完成。一次性部署脚本和临时部署包也已清理，不会影响后续正式部署。

## 本地开发与测试

```bash
npm ci
npm run verify
```

测试包含：

- `tests/parse.test.js`：星图宽容解析回归；
- `tests/index-contract.test.js`：前端结构与行为锁；
- `tests/relay-contract.test.js`：端点白名单、请求校验、思考预算和限流键；
- `tests/relay-integration.test.js`：用现有前端请求格式验证验证、普通轮回退、星图结算与幂等重试；
- `tests/state-store.test.js`：并发预占、失败释放、修复恢复和单次结算。

本地测试会显式使用内存实现。它只模拟状态层的行为，不代表生产可以不接 Redis。

## 目录

| 路径 | 说明 |
| --- | --- |
| `index.html` | 唯一前端页面；v2.6.20，仅同步验证提示、版本展示、就绪检查和后端错误提示 |
| `scf-relay.js` | SCF 入口：验证、状态预占/结算、千帆转发和 HTTP 边界 |
| `state-store.js` | Redis 生产实现与内存测试实现；关键操作使用 Redis Lua 原子脚本 |
| `scf_bootstrap` | SCF 启动脚本，选择可运行的 Node 18/20 |
| `package.json` / `package-lock.json` | Redis 运行依赖和可重复安装锁文件 |
| `tests/` | 前端、解析器、中转服务与状态层测试 |
| `fonts/` / `vendor/` | 前端自托管字体和截图组件 |
| `legacy/` | v1 原样存档 |
| `archive/` | 早期调试库原样存档 |

## 版本与回滚

- 前端版本：`v2.6.20`，与本次后端就绪检查和提示同步；
- 后端版本：`v2.7.0-stateful`；
- Redis 前缀：默认 `beichen:v27`，用于与旧内存版本隔离；
- 回滚时恢复上一个云函数包即可；旧代码不会读取新版 Redis 状态，用户需要重新验证动态码，不会造成旧代码凭空多出次数；
- 回滚或更换 Redis 前先保留当前函数版本和环境变量清单，但清单只能保存在受控密码管理器中，不能提交到 GitHub。

## 维护与免责声明

维护者：予笙。动态验证码按需发放；TOTP seed、会话签名密钥、千帆 Key 和 Redis 凭据永不入库。

北辰的星图与数据参考仅为探索辅助，正式选科以本省教育考试院政策与高校招生章程为准。
