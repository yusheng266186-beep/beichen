# 北辰新手部署指南（腾讯云 Web 函数 + Redis + 千帆）

这份指南覆盖正式库 `yusheng266186-beep/beichen` 的前后端对齐部署。页面只同步后端变化确实需要的提示、版本和就绪检查，聊天内容与其他无关页面行为不变。

这次后端版本是 `v2.7.0-stateful`，页面版本是 `v2.6.20`。真实的千帆 Key、动态码 seed、会话签名密钥和 Redis 密码只填写在腾讯云的加密环境变量里，绝不能写回 GitHub。

## 1. 准备工作

需要准备：

- 腾讯云 Web 函数权限，运行时选择 Nodejs18 或 Nodejs20；
- 一个 Redis 实例，建议使用腾讯云同一网络内的托管 Redis；
- 百度千帆 Token Plan 个人版 Mini 专属 API Key；
- 动态验证码应用对应的 TOTP seed；
- 至少 32 字节的随机 `GATE_SESSION_SECRET`；
- 本仓库的后端文件和依赖。

Redis 不是用来存聊天记录的。它只存会话票据状态、次数状态、TOTP 防重放标记、临时请求预占和短期结算收据。

## 2. 准备部署包

在仓库根目录执行：

```bash
npm ci --omit=dev
```

部署包根目录必须包含下面这些内容：

```text
scf-relay.js
state-store.js
scf_bootstrap
package.json
package-lock.json
node_modules/
```

其中 `node_modules/` 不能省略，因为 SCF 需要运行时加载 `redis` 依赖。不要把 `.env`、导出的环境变量、控制台截图或任何含真实值的文件放进压缩包。

### zip 的两个要求

`scf_bootstrap` 必须是 LF 换行并保留 755 权限。最稳妥的做法是在 Linux/macOS 或 WSL 中打包：

```bash
chmod 755 scf_bootstrap
zip -r deploy.zip scf-relay.js state-store.js scf_bootstrap package.json package-lock.json node_modules
```

如果使用 Python 打包，至少要给启动脚本保留 Unix 权限位：

```python
from pathlib import Path
import zipfile

root_files = (
    "scf-relay.js",
    "state-store.js",
    "scf_bootstrap",
    "package.json",
    "package-lock.json",
)

with zipfile.ZipFile("deploy.zip", "w", zipfile.ZIP_DEFLATED) as z:
    files = [Path(name) for name in root_files]
    files += [path for path in Path("node_modules").rglob("*") if path.is_file()]
    for path in files:
        name = path.as_posix()
        info = zipfile.ZipInfo(name)
        info.external_attr = 0o755 << 16 if name == "scf_bootstrap" else 0o644 << 16
        info.create_system = 3
        with path.open("rb") as f:
            z.writestr(info, f.read())
```

常见错误是 `/bin/bash^M: bad interpreter`（CRLF）或启动文件没有执行权限。遇到这两种错误，重新按上面方法打包。

## 3. 创建 Web 函数

1. 打开腾讯云函数（SCF）控制台，选择“创建函数” → “Web 函数”。
2. 运行时选择 **Nodejs20** 或 **Nodejs18**。
3. 上传 `deploy.zip`，处理程序/Handler 填 `scf_bootstrap`。
4. 端口填 `9000`，公网访问打开，执行超时设为 **600 秒**。
5. 确保函数所在网络可以访问 Redis；如果千帆请求需要公网出口，也要配置对应的 NAT/公网出口。

`scf_bootstrap` 会从 `/var/lang/node20/bin/node` 或 `/var/lang/node18/bin/node` 选择可运行的 Node。它不会读取前端文件。

## 4. 配置加密环境变量

生产至少填写以下项目：

| 名称 | 填写内容 |
| --- | --- |
| `STATE_STORE` | 固定填 `redis` |
| `REDIS_URL` | Redis 连接地址；TLS 通常使用 `rediss://` |
| `BEICHEN_REDIS_PREFIX` | 建议填 `beichen:v27`；不同环境使用不同前缀 |
| `QIANFAN_API_KEY` | Token Plan 个人版 Mini 专属 API Key |
| `QIANFAN_BASE_URL` | `https://qianfan.baidubce.com/v2/tokenplan/personal` |
| `QIANFAN_MODEL` | `qianfan-code-latest`，或账号已开通的模型 ID |
| `GATE_TOTP_SECRET` | TOTP 应用的 Base32 seed，不是当前 6 位数字 |
| `GATE_SESSION_SECRET` | 至少 32 字节的随机字符串 |
| `CORS_ALLOWED_ORIGINS` | `https://yusheng266186-beep.github.io`，不要带 `/beichen/` 路径 |
| `PORT` | `9000` |

如果托管 Redis 不提供完整 URL，也可以用下面这些变量替代 `REDIS_URL`：

```text
REDIS_HOST=内网地址
REDIS_PORT=6379
REDIS_USERNAME=（如服务要求）
REDIS_PASSWORD=（真实值只填云端）
REDIS_TLS=true 或 false
REDIS_DB=0
```

保留这些已有变量名，不要改成新的 Key 名称：`GATE_TOTP_SECRET`、`GATE_SESSION_SECRET`、`QIANFAN_API_KEY`、`QIANFAN_BASE_URL`、`QIANFAN_MODEL`。代码不会打印它们的值。

不要填写普通后付费 Key，也不要把 Coding Plan/Coding Plan Lite 的专属 Key 或地址混到这套配置里。中转层只放行 Token Plan 个人版端点。

## 5. 部署后检查

从腾讯云函数的公网 URL 执行：

```bash
curl -i https://你的函数域名/healthz
curl -i https://你的函数域名/readyz
```

`/healthz` 是存活检查；`/readyz` 必须返回 HTTP 200，并且 JSON 中同时显示：

```json
{
  "ok": true,
  "ready": true,
  "providerConfigured": true,
  "stateStore": "redis",
  "stateStoreReachable": true
}
```

如果 `/readyz` 不是 200：

- `stateStoreReachable=false`：检查 Redis 地址、密码、TLS、VPC/安全组和函数出网；
- `providerConfigured=false`：检查千帆 Key、会话密钥和 TOTP seed 是否已经以环境变量配置；
- 只显示 401/403：检查公网访问和 `CORS_ALLOWED_ORIGINS`，不要先改页面。

然后打开本次更新后的 Pages 页面，先进入设置点击“检查连接”。正常情况下应显示“正常”，并看到后端 `v2.7.0-stateful`、页面 `v2.6.20`。如果显示“未就绪”，优先处理 Redis 或云端配置；如果显示“需同步”，说明页面和函数不是同一版本。

确认连接正常后，再完成一次完整流程：输入动态码 → 普通聊天 → 生成星图 → 等待星图完成 → 确认次数。页面仍会访问现有的 `/verify`、`/chat/completions` 和 `/run/complete`，本次只新增读取 `/readyz` 的设置页检查，不需要改变聊天接口。

## 6. 页面地址什么时候需要改

本次页面版本已经同步到 `v2.6.20`。当前页面里的 `RELAY` 仍指向正式函数，只有迁移到另一套云函数时才需要改地址。

只有在你新建了另一套云函数，或者故意把正式页面切到新域名时，才同时修改页面中的：

1. `RELAY` 函数地址；
2. CSP 的 `connect-src` 对应域名。

这两处必须使用同一个函数域名。不要把 API Key、TOTP seed 或 `GATE_SESSION_SECRET` 放进页面；前端永远不应该持有它们。

## 7. 这次改动解决了什么

- 同一个动态码在多台函数实例之间只能成功一次；
- 同一个会话的次数由 Redis 原子操作决定，不会因扩容而每台各算一遍；
- 普通聊天上游失败不消耗一轮；
- 星图没有成功生成时不能确认扣次数；
- 同一个 `X-Request-ID` 重试只返回第一次结算结果；
- Redis 断开时不自动退回内存，不会因为故障制造另一套“看不见的次数”；
- 函数重启后状态仍在 Redis，正在运行但超过租约的请求会被回收；
- Redis 只保存必要的状态，不保存聊天正文。

## 8. 更新与回滚

更新函数会重启实例，但新版关键状态已经在 Redis；部署前记录当前函数版本、环境变量名称和 Redis 前缀，不要记录真实值到 GitHub。

回滚时选择腾讯云保留的上一版函数包。旧版内存代码不会读取 `beichen:v27` 中的新状态，因此回滚后用户可能需要重新输入动态码，这是安全的；不要为了“迁移旧内存次数”而手工改 Redis。

更换环境时使用新的 `BEICHEN_REDIS_PREFIX`，例如测试环境和正式环境分别使用不同前缀，防止两套函数共享会话和次数。

## 9. 本地检查

提交或部署前，在仓库根目录执行：

```bash
npm ci
npm run verify
```

测试通过后再打包。`.env.example` 只有空值和占位符，不能直接作为生产 Secret；仓库内也不应该出现 `.env` 或任何真实密钥。
