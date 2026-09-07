# 北辰 Redis 开关

Windows 用户双击 `Redis-Switch.cmd`，选择查看、开启或关闭。关闭和开启操作仍会要求输入 `yes`；日常请串行操作。

## 首次配置（GitHub 下载版）

1. 安装 Python 3.10+、GitHub CLI，并使用 `gh auth login` 登录有目标仓库 Actions 变量写权限的账号。
2. 运行 `python -m pip install -r requirements-redis-switch.txt`。
3. 将 `redis-switch.config.example.json` 复制为 `redis-switch.config.json`，填写函数名、地域、目标仓库和 HTTPS relay_url。
4. 腾讯云凭据从环境变量 `TENCENTCLOUD_SECRET_ID`、`TENCENTCLOUD_SECRET_KEY` 读取；也可在配置的 `handover_file` 填写本机私有《操作执行清单.md》的绝对路径。配置文件中无需填真实密钥。
5. 仓库需已有 `SENTINEL_MODE` Actions 变量和 sentinel.yml。Redis 实例名称为 `beichen-state-redis`，需要与云函数 VPC/子网一致。
6. 第一次关闭现有运行中的按量 Redis 会生成 `redis-snapshot.json`。没有快照和现有实例时，`on` 会拒绝猜测创建参数。桌面已配置版已保留本机快照。

## 命令行

```powershell
python redis_switch.py status
python redis_switch.py on
python redis_switch.py off
python test_redis_switch.py
```

`on/off --yes` 适用于已明确确认的脚本调用。`BEICHEN_REDIS_CONFIG` 可指定配置文件，`BEICHEN_HANDOVER_FILE` 可覆盖文档路径，`BEICHEN_RELAY_URL` 可覆盖服务地址。

## 行为与验收

- off：核对按量实例与网络、保存配置快照、关闭哨兵、销毁实例并确认删除状态。
- on：复用现有实例或先预检再创建；从云函数读取规范 VPC/子网 ID 和 Redis 密码；接回 REDIS_HOST/REDIS_PORT；就绪探针成功后恢复哨兵。
- 快照只保存重建配置，不保存 Redis 数据。关闭会清空云端会话、额度和防重放状态；开启重新按量计费。
- 2026-09-07 完成真实关→开循环，关闭时 503/ready=false，开启后 200/ready=true；两种哨兵状态均在 GitHub Actions 实测成功，14 项脚本回归通过。
- 缺失 TypeId 的旧快照采用本次验证过的 TypeId=17；256MB/1副本保持不变。余额不足明确退出；不要同时运行多个开关进程。

不要上传实际 `redis-switch.config.json`、`redis-snapshot.json`、私有交接文档或凭据。GitHub 发行包只含程序、示例配置和说明；桌面版的配置引用本机现有私有文档。
