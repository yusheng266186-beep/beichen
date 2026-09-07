# -*- coding: utf-8 -*-
"""北辰 Redis 一键开关:销毁/重建按量实例,不用时零费用。
用法:
  python redis_switch.py            # 查看当前状态
  python redis_switch.py off        # 销毁实例(停止计费;学生端将显示服务不可用)
  python redis_switch.py on         # 按快照重建(单副本256MB)并自动改回函数指向+冒烟
快照存本目录 redis-snapshot.json(off 时自动生成,含 VPC/可用区/端口;不含任何密钥)。
重建时密码自动取云函数环境变量 REDIS_PASSWORD,不落盘、不打印。
"""
import json, re, sys, time
from pathlib import Path

import os as _os
HERE = Path(__file__).resolve().parent
CONFIG_PATH = Path(_os.environ.get("BEICHEN_REDIS_CONFIG", str(HERE / "redis-switch.config.json")))
CONFIG = json.loads(CONFIG_PATH.read_text(encoding="utf-8-sig")) if CONFIG_PATH.exists() else {}
HANDOVER = Path(_os.environ.get("BEICHEN_HANDOVER_FILE") or CONFIG.get("handover_file") or str(HERE.parent / "操作执行清单.md"))
SNAP = HERE / "redis-snapshot.json"
FN = CONFIG.get("function_name", "beichen-qianfan-mini")
REGION = CONFIG.get("region", "ap-chengdu")
GH_REPO = CONFIG.get("github_repo", "yusheng266186-beep/beichen")
FORMAL_URL = _os.environ.get("BEICHEN_RELAY_URL") or CONFIG.get("relay_url", "")
# 本机原代理会干扰云 API；此工具直连并保持标准 TLS 证书验证。
for _k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"):
    _os.environ.pop(_k, None)
from tencentcloud.scf.v20180416.scf_client import ScfClient
for _k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"):
    _os.environ.pop(_k, None)
import requests  # noqa: E402

from tencentcloud.common import credential  # noqa: E402
from tencentcloud.common.profile.client_profile import ClientProfile  # noqa: E402
from tencentcloud.common.profile.http_profile import HttpProfile  # noqa: E402
from tencentcloud.redis.v20180412 import models as rmodels  # noqa: E402
from tencentcloud.redis.v20180412.redis_client import RedisClient  # noqa: E402
from tencentcloud.scf.v20180416 import models as smodels  # noqa: E402


def creds():
    sid = _os.environ.get("TENCENTCLOUD_SECRET_ID")
    skey = _os.environ.get("TENCENTCLOUD_SECRET_KEY")
    if sid and skey:
        return sid, skey
    if not HANDOVER.exists():
        raise SystemExit("请配置腾讯云环境变量，或在 redis-switch.config.json 中设置本机 handover_file")
    document = HANDOVER.read_text(encoding="utf-8-sig")
    sid_match = re.search(r"腾讯云 SecretId[^`]*`([A-Za-z0-9]+)`", document)
    key_match = re.search(r"腾讯云 SecretKey[^`]*`([A-Za-z0-9]+)`", document)
    if not sid_match or not key_match:
        raise SystemExit("本机交接文档没有找到腾讯云凭据，请检查配置")
    return sid_match.group(1), key_match.group(1)


def redis_client(sid, skey):
    c = credential.Credential(sid, skey)
    hp = HttpProfile(); hp.endpoint = "redis.tencentcloudapi.com"
    return RedisClient(c, REGION, ClientProfile(httpProfile=hp))


def scf_client(sid, skey):
    c = credential.Credential(sid, skey)
    hp = HttpProfile(); hp.endpoint = "scf.tencentcloudapi.com"
    return ScfClient(c, REGION, ClientProfile(httpProfile=hp))


def find_instance(cl):
    matches = []
    offset = 0
    while True:
        req = rmodels.DescribeInstancesRequest(); req.Limit = 100; req.Offset = offset
        resp = cl.DescribeInstances(req)
        matches.extend(it._serialize() for it in resp.InstanceSet
                       if it.InstanceName == "beichen-state-redis" and it.Status != -3)
        offset += len(resp.InstanceSet)
        if not resp.InstanceSet or offset >= resp.TotalCount:
            break
    if len(matches) > 1:
        raise SystemExit("发现多个同名北辰 Redis 实例，请先核对，未执行变更")
    return matches[0] if matches else None


def get_function_env(cl):
    g = smodels.GetFunctionRequest(); g.FunctionName = FN
    d = cl.GetFunction(g)
    return {v.Key: v.Value for v in d.Environment.Variables}


def set_function_env(cl, env_map):
    e = smodels.Environment()
    vs = []
    for k, v in env_map.items():
        var = smodels.Variable(); var.Key = k; var.Value = v; vs.append(var)
    e.Variables = vs
    uf = smodels.UpdateFunctionConfigurationRequest()
    uf.FunctionName = FN; uf.Environment = e
    cl.UpdateFunctionConfiguration(uf)


def gh_set_var(name, value):
    import subprocess
    subprocess.run(["gh", "api", "-X", "PATCH",
                    "repos/" + GH_REPO + "/actions/variables/" + name,
                    "-f", "value=" + value], check=True)


def wait_redis_ready(cl, instance_id, minutes=10):
    for i in range(minutes * 6):
        time.sleep(10)
        req = rmodels.DescribeInstancesRequest(); req.InstanceId = instance_id; req.Limit = 20
        resp = cl.DescribeInstances(req)
        for it in resp.InstanceSet:
            if it.InstanceId == instance_id:
                st = it.Status
                print(f"  redis poll{i}: status={st} ip={getattr(it, 'Vip', None) or it.WanIp}")
                if st == 2:
                    return it._serialize()
    raise SystemExit("TIMEOUT waiting redis ready")


def wait_scf_active(cl, minutes=6):
    for i in range(minutes * 6):
        time.sleep(10)
        g = smodels.GetFunctionRequest(); g.FunctionName = FN
        d = cl.GetFunction(g)
        print(f"  scf poll{i}: {d.Status}")
        if d.Status in ("Active", "Running"):
            return
    raise SystemExit("TIMEOUT waiting scf active")


def smoke():
    if not FORMAL_URL.startswith("https://"):
        raise SystemExit("请先配置 HTTPS relay_url 或 BEICHEN_RELAY_URL")
    sess = requests.Session()
    rz = sess.get(FORMAL_URL + "/readyz", timeout=60)
    print("[smoke] /readyz ->", rz.status_code, rz.text[:160])
    return rz.status_code == 200 and rz.json().get("ready") is True


def cmd_status(sid, skey):
    cl = redis_client(sid, skey)
    inst = find_instance(cl)
    snap = json.loads(SNAP.read_text(encoding="utf-8")) if SNAP.exists() else {}
    if inst:
        st = inst.get("Status")
        print("状态:", "开(运行中)" if st == 2 else "处理中(销毁/变更中, Status=" + str(st) + ")")
        print("  ID:", inst.get("InstanceId"), "| 规格:", inst.get("ProductType"),
              inst.get("Size"), "MB | 副本:", inst.get("RedisReplicasNum"),
              "| 内网:", inst.get("Vip") or inst.get("WanIp"))
    else:
        print("状态: 关(实例已销毁,不计费)")
    if SNAP.exists():
        print("快照: 存在(可用区 " + str(snap.get("zone")) + ", " + str(snap.get("memSize")) + "MB, 副本", snap.get("replicas"), ")")
    else:
        print("快照: 尚未生成(执行一次 off 自动生成)")
    cl_s = scf_client(sid, skey)
    env = get_function_env(cl_s)
    host = env.get("REDIS_HOST", "")
    print("函数 REDIS_HOST:", (host[:12] + "...") if host else "(空)")


def cmd_off(sid, skey, yes):
    cl = redis_client(sid, skey)
    inst = find_instance(cl)
    if not inst:
        gh_set_var("SENTINEL_MODE", "off")
        print("已经是关(实例不存在)，哨兵已关闭"); return
    if inst.get("Status") != 2 or inst.get("BillingMode") != 0:
        raise SystemExit("实例不是运行中的按量实例，未执行销毁")
    iid = inst.get("InstanceId")
    if not yes:
        ans = input(f"确认销毁 {inst.get('InstanceName')}({iid})? 学生端将立即不可用,会话状态清空。输入 yes 确认: ")
        if ans.strip().lower() != "yes":
            print("已取消"); return
    snap = {
        "instanceId": iid,
        "zone": inst.get("ZoneId"),
        "zoneName": inst.get("ZoneName", ""),
        "vpc": inst.get("VpcId"),
        "subnet": inst.get("SubnetId"),
        "port": inst.get("Port", 6379),
        "memSize": inst.get("Size", 256),
        "shardNum": inst.get("RedisShardNum", 1),
        "replicas": inst.get("RedisReplicasNum", 1),
        "typeId": inst.get("Type"),
        "at": time.strftime("%F %T"),
    }
    g = smodels.GetFunctionRequest(); g.FunctionName = FN
    network = scf_client(sid, skey).GetFunction(g).VpcConfig
    snap["vpc"] = inst.get("UniqVpcId") or network.VpcId
    snap["subnet"] = inst.get("UniqSubnetId") or network.SubnetId
    if snap["vpc"] != network.VpcId or snap["subnet"] != network.SubnetId:
        raise SystemExit("Redis 与云函数网络不一致，未执行销毁")
    snap["typeId"] = inst.get("Type") or 17
    SNAP.write_text(json.dumps(snap, ensure_ascii=False, indent=2), encoding="utf-8")
    print("[off] 快照已存:", SNAP.name)
    gh_set_var("SENTINEL_MODE", "off")
    req = rmodels.DestroyPostpaidInstanceRequest(); req.InstanceId = iid
    cl.DestroyPostpaidInstance(req)
    print("[off] 销毁请求已提交,计费即止")
    print("[off] 值班哨兵已切到 off")
    for attempt in range(60):
        req = rmodels.DescribeInstancesRequest(); req.InstanceId = iid; req.Limit = 20
        result = cl.DescribeInstances(req)
        current = next((it for it in result.InstanceSet if it.InstanceId == iid), None)
        if current is None or current.Status == -3:
            print("[off] 已确认实例删除/进入回收站")
            return
        time.sleep(5)
    raise SystemExit("销毁请求已提交但尚未确认完成，请运行 status 核实")


def cmd_on(sid, skey, yes):
    """按快照自动创建，连接云函数，冒烟通过后恢复哨兵。"""
    if not FORMAL_URL.startswith("https://"):
        raise SystemExit("请先配置 HTTPS relay_url，再运行 on")
    cl = redis_client(sid, skey)
    cl_s = scf_client(sid, skey)
    inst = find_instance(cl)
    if not inst:
        if not SNAP.exists():
            raise SystemExit("没有快照，无法确定重建规格；未创建实例")
        snap = json.loads(SNAP.read_text(encoding="utf-8"))
        g = smodels.GetFunctionRequest(); g.FunctionName = FN
        function = cl_s.GetFunction(g)
        env = {v.Key: v.Value for v in function.Environment.Variables}
        network = function.VpcConfig
        if not network.VpcId.startswith("vpc-") or not network.SubnetId.startswith("subnet-"):
            raise SystemExit("云函数未配置有效的 VPC/子网，未创建实例")
        password = env.get("REDIS_PASSWORD")
        if not password:
            raise SystemExit("云函数缺少 REDIS_PASSWORD")
        if not yes and input("确认按快照创建按量 Redis 并恢复服务？输入 yes: ").strip().lower() != "yes":
            return
        params = dict(TypeId=snap.get("typeId") or 17, MemSize=snap["memSize"],
                      GoodsNum=1, Period=1, BillingMode=0, ZoneId=snap["zone"],
                      Password=password, VpcId=network.VpcId, SubnetId=network.SubnetId,
                      InstanceName="beichen-state-redis", RedisReplicasNum=snap.get("replicas") or 1,
                      VPort=snap.get("port", 6379), DryRun=True)
        req = rmodels.CreateInstancesRequest(); req.from_json_string(json.dumps(params))
        cl.CreateInstances(req)
        print("[on] 创建预检通过，正在创建按量 Redis", flush=True)
        req.DryRun = False
        # 创建请求不自动重试：网络结果不确定时，应先查询实例，避免重复计费。
        try:
            created = cl.CreateInstances(req)
        except Exception as exc:
            if getattr(exc, "code", "") == "FailedOperation.PayFailed":
                raise SystemExit("腾讯云余额不足或支付失败，未完成创建；补足余额后重试 on") from None
            raise
        if len(created.InstanceIds or []) != 1:
            raise SystemExit("创建未返回唯一实例 ID，请在控制台核实后再继续")
        snap.update(instanceId=created.InstanceIds[0], typeId=params["TypeId"],
                    vpc=network.VpcId, subnet=network.SubnetId)
        SNAP.write_text(json.dumps(snap, ensure_ascii=False, indent=2), encoding="utf-8")
        inst = wait_redis_ready(cl, created.InstanceIds[0])
    elif inst.get("Status") == -2:
        raise SystemExit("实例处于隔离状态，请在控制台处理；未重复创建")
    elif inst.get("Status") != 2:
        inst = wait_redis_ready(cl, inst["InstanceId"])
    inst_id = inst.get("InstanceId")
    new_ip = inst.get("Vip") or inst.get("WanIp")
    env = get_function_env(cl_s)
    password = env.get("REDIS_PASSWORD", "")
    if not password:
        raise SystemExit("云函数环境变量里没有 REDIS_PASSWORD")
    if not new_ip:
        raise SystemExit("实例没有可用内网地址")
    env["REDIS_HOST"] = new_ip
    env["REDIS_PORT"] = str(inst.get("Port") or 6379)
    if not yes:
        ans = input(f"确认把 {inst_id}({new_ip}) 接回云函数并重启函数? 输入 yes 确认: ")
        if ans.strip().lower() != "yes":
            print("已取消"); return
    set_function_env(cl_s, env)
    print("[on] 函数环境变量 REDIS_HOST 已更新,等待函数重启...")
    wait_scf_active(cl_s, 3)
    time.sleep(5)
    ready = False
    for attempt in range(6):
        try:
            ready = smoke()
        except (requests.RequestException, ValueError):
            print("[smoke] 请求暂未成功，等待重试")
        if ready:
            break
        time.sleep(5)
    if ready:
        gh_set_var("SENTINEL_MODE", "on")
        print("[on] 值班哨兵已恢复监测")
        print("REDIS 已接回,服务恢复,", time.strftime("%F %T"))
    else:
        raise SystemExit("冒烟未通过，未恢复哨兵；实例仍存在，修复后重跑 on")


def main():
    sid, skey = creds()
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    if cmd == "status":
        cmd_status(sid, skey)
    elif cmd == "off":
        cmd_off(sid, skey, yes=("--yes" in sys.argv))
    elif cmd == "on":
        cmd_on(sid, skey, yes=("--yes" in sys.argv))
    else:
        raise SystemExit("用法: python redis_switch.py [status|off|on] [--yes]")


if __name__ == "__main__":
    main()
