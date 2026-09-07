# 北辰 Redis 开关 1.0.1

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

## 1.0.1：关闭失败与操作反馈修复

- 云 API 只读请求遇到暂时性断连自动重试两次，单次超时 15 秒。GitHub 同值更新同样可重试。
- 暂停哨兵失败不再阻断关闭。关闭成功但哨兵失败会单独告警，退出码 2；可重复关闭修复哨兵，不会重复创建资源。
- 删除请求响应中断时查询实际状态，不直接重发删除。只有查到实例删除才报告成功。
- 菜单保留结果，按回车回主菜单；选 4 查看操作记录。取消、失败、完成但有警告使用不同提示。
- 本机多个副本共用操作锁；开启全过程只确认一次。
- 日志在程序旁 redis-switch.log，仅记脱敏进度与错误类型，不记凭据及异常原始载荷。
- 24 项回归覆盖，包括 GitHub 故障不阻断关闭、网络恢复、删除响应丢失、拒绝删除时恢复监测、重复进程锁等。

2026-09-07：本机日志显示 11:36 实际删除成功，15:43 复核已关闭且哨兵 off。旧版未记录原失败信息，无法把原失败唯一归因于某次网络调用。
