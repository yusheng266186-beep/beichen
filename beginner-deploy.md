# 北辰新手部署指南（腾讯云 Web 函数 + 千帆 Mini）

这份指南只做一件事：让网页通过腾讯云函数安全地调用百度千帆。仓库不会预填任何 API Key、TOTP seed 或 session secret；这些值只能填写在腾讯云的加密环境变量中。

## 你需要准备什么

- 一个腾讯云账号和可创建“Web 函数”的权限；
- 百度千帆 Token Plan 个人版 Mini 专属 API Key；Mini 是额度套餐，不是模型名；
- 一个 6 位动态验证码对应的 TOTP seed（只放在腾讯云 Secret 中，不要把 seed 或当前验证码提交到 GitHub）；
- 一个至少 32 字节的随机 `GATE_SESSION_SECRET`，建议由密码管理器生成；
- 本仓库中的 `scf-relay.js` 和 `index.html`。

## A. 创建腾讯云中转函数

1. 打开腾讯云函数（SCF）控制台，选择“创建函数” → “Web 函数”。运行时优先选择 **Nodejs20** 或 **Nodejs18**（Nodejs16.13 已 EOL，仅作兜底——`scf_bootstrap` 自带 node 二进制运行时自检，会自动挑镜像里能跑的 node）。
2. 上传仓库根目录的 **`scf-relay.js` + `scf_bootstrap`**（打成 zip，两个文件都放在压缩包根目录）。`scf_bootstrap` 是启动文件（处理程序/Handler 填它），自带 node 二进制运行时自检；不要上传含有真实密钥的文件。

   **zip 两个铁律**（此前的事故：打包丢可执行位 + 换行符被转成 CRLF，函数直接起不来）：

   - **换行必须是 LF**：仓库 `.gitattributes`（`scf_bootstrap text eol=lf`）已保证库内与检出均为 LF；若你自行拷贝 `scf_bootstrap` 再打包，先用编辑器确认文件里没有 `^M`。
   - **必须带可执行位 755**：Windows 的压缩工具（含右键“压缩为 zip”）不保留 Unix 权限位。用 Python `zipfile` 打包请照抄下面配方：

     ```python
     import zipfile

     with zipfile.ZipFile("deploy.zip", "w") as z:
         for name in ("scf-relay.js", "scf_bootstrap"):
             info = zipfile.ZipInfo(name)       # 两个文件都放在压缩包根目录
             info.external_attr = 0o755 << 16   # 铁律二：可执行位 755
             info.create_system = 3             # 标记为 Unix，权限位才会生效
             with open(name, "rb") as f:
                 z.writestr(info, f.read())
     ```

   踩坑症状：函数启动失败，日志出现 `/bin/bash^M: bad interpreter`（CRLF 所致）或 `no such file or directory`（丢可执行位）。遇到其一，按上面两条重新打包即可。
3. 端口填写 **9000**（代码默认监听 9000；也可保留 `PORT=9000`）。
4. 在“环境变量/密钥”中填写下面 4 项。只需要填你自己的值：

   | 名称 | 填什么 |
   | --- | --- |
   | `QIANFAN_API_KEY` | Token Plan 个人版 Mini 专属 API Key；仅服务端保存 |
   | `GATE_TOTP_SECRET` | 动态验证码应用使用的 Base32 seed；不是当前 6 位数字 |
   | `GATE_SESSION_SECRET` | 至少 32 字节随机字符串；用于签发会话 Token |
   | `CORS_ALLOWED_ORIGINS` | 网页来源，例如 `https://yusheng266186-beep.github.io`，不要写 `/beichen/` 路径 |

   `QIANFAN_BASE_URL` 填 Token Plan 个人版专属地址 `https://qianfan.baidubce.com/v2/tokenplan/personal`（个人版专属 Key 只认这个入口，也是代码唯一放行的入口）。`QIANFAN_MODEL` 可以留空，默认模型是 **`qianfan-code-latest`**，也可以填写你账号已开通的模型 ID。模板见根目录 [`.env.example`](.env.example)，它只有占位符，不能直接当作真实 Secret 使用。

   不要把普通后付费 key 或 Coding Plan/Coding Plan Lite 专属 key、专属 endpoint 填进 `QIANFAN_API_KEY`。本适配器只访问 Token Plan 个人版专属端点 `/v2/tokenplan/personal/chat/completions`（见[官方接入文档](https://cloud.baidu.com/doc/qianfan/s/kmracfgi2)）；代码内置 host 与 endpoint 白名单，标准 `/v2`、coding 系与任何第三方域名都会被直接拒绝。

   旧版本实例的环境变量里可能还留着 `AI_PROVIDER`、`TRUST_PROXY` 等历史变量——当前代码不读取它们，留着无害；不要为了清理专门更新一次函数（会重启实例、清掉内存会话），下次因其他原因更新配置时顺手删掉即可。

5. 在函数设置中打开 **公网访问**，执行超时设置为 **600 秒**。保存并部署；中转层默认会在 540 秒时结束上游请求，为函数留出收尾时间。
6. 从控制台复制部署后的 **HTTPS 函数 URL**。记下它，但不要把 URL 当作 API Key；不要在聊天、README 或代码中填写任何 Secret。

## B. 让网页连接你的函数

1. 仓库中 `index.html` 的 `RELAY` 常量当前是维护者已部署的线上函数地址（约 1084 行，紧邻一行 "Deployment placeholder: replace the entire origin and the CSP connect-src entry together." 英文注释）。复刻者需要把它换成**你自己的** HTTPS 函数 URL（不要重复末尾 `/`）：

   ```js
   const RELAY = 'https://<你的函数ID>-<随机串>.ap-chengdu.tencentscf.com';
   ```

2. 同一文件第 7 行 CSP 的 `connect-src` 里是**同一个域名**，必须与 `RELAY` **成对**替换——上面那行英文注释说的就是这件事：origin 和 connect-src 要一起换，两处不一致会被浏览器 CSP 拦截。新仓库默认不会连接旧 `beichen` 后端。
3. `tests/index-contract.test.js` 会用正则把 `RELAY` 与 `connect-src` 钉死为 `https://<子域>.ap-chengdu.tencentscf.com` 形态。换成你自己的**同区域（ap-chengdu）**函数地址后，测试照常通过，不需要改测试。
4. 提交前自查：确认 `index.html` 中没有残留任何不属于你的 `tencentscf.com` 域名，且没有任何 API Key、TOTP seed 或 session secret。
5. GitHub 仓库的 Settings → Pages 选择 `main` 分支发布。网页来源必须与 `CORS_ALLOWED_ORIGINS` 完全一致（协议、域名、端口都要一致）。

## C. 第一次验证

1. 打开网页，输入 TOTP 应用当前显示的 6 位验证码。
2. 完成一轮对话，确认能生成星图。
3. 若显示“验证服务不可用”，先检查函数是否公网可访问、`CORS_ALLOWED_ORIGINS` 是否是网页的 origin，以及 `GATE_SESSION_SECRET` 是否至少 32 字节。
4. 若显示模型凭据错误，确认 Mini 专属 `QIANFAN_API_KEY`、`QIANFAN_BASE_URL`（必须是个人版专属端点）和 `QIANFAN_MODEL`。不需要修改前端 API Key，因为前端永远不应持有它。

## 部署前安全检查

在仓库目录执行：

```text
node tests/relay-contract.test.js
node tests/index-contract.test.js
node tests/parse.test.js
node --check scf-relay.js
```

不要执行或提交包含真实值的 `.env` 文件。`.gitignore` 已忽略 `.env`/`.env.*`，但仍应在推送前人工检查。没有外部数据库时，Token、额度和防重放状态只在当前函数实例内存中；实例重启或多实例扩容时可能需要重新验证，正式多人服务应接入支持原子更新的 KV/数据库。

## 暂时不要做的事

- 不要把 API Key 写入 `index.html`、README、截图、Issue 或日志；
- 不要把 Coding Plan/Coding Plan Lite 专属接口当作自定义后端；
- 不要把 Qianfan URL 改成上述两个官方端点之外的路径或任意域名；代码有 hostname allowlist 和 endpoint 白名单；
- 不要在没有先完成本地测试和密钥扫描前部署。
