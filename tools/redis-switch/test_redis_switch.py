import contextlib, io, json, tempfile, unittest
from pathlib import Path
from types import SimpleNamespace as NS
from unittest.mock import Mock, patch
import redis_switch as s

class SwitchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.snap = Path(self.temp.name)/'redis-snapshot.json'
        self.snap.write_text(json.dumps(dict(zone=160001,memSize=256,replicas=1,port=6379)),encoding='utf-8')
        self.rc=Mock(); self.sc=Mock()
        self.inst=dict(InstanceName='beichen-state-redis',InstanceId='crs-test',Status=2,
                      BillingMode=0,Type=17,Size=256,ZoneId=160001,RedisReplicasNum=1,
                      WanIp='10.0.0.8',Port=6379,UniqVpcId='vpc-test',UniqSubnetId='subnet-test')
        self.sc.GetFunction.return_value=NS(VpcConfig=NS(VpcId='vpc-test',SubnetId='subnet-test'),
            Environment=NS(Variables=[NS(Key='REDIS_PASSWORD',Value='fake-test-secret'),NS(Key='KEEP',Value='retained')]))
        for target,value in [('LOG',Path(self.temp.name)/'run.log'),('FORMAL_URL','https://example.com'),('SNAP',self.snap),('redis_client',Mock(return_value=self.rc)),('scf_client',Mock(return_value=self.sc))]:
            p=patch.object(s,target,value);p.start();self.addCleanup(p.stop)
        for target in ['gh_set_var','wait_scf_active','set_function_env']:
            p=patch.object(s,target);setattr(self,target,p.start());self.addCleanup(p.stop)
        p=patch.object(s.time,'sleep');p.start();self.addCleanup(p.stop)
        p=patch.object(s,'smoke',return_value=True);self.smoke=p.start();self.addCleanup(p.stop)
        p=patch.object(s,'find_instance',return_value=self.inst);self.find=p.start();self.addCleanup(p.stop)
        self.capture=contextlib.redirect_stdout(io.StringIO());self.capture.__enter__();self.addCleanup(self.capture.__exit__,None,None,None)
    def test_existing_on_does_not_create_and_keeps_other_env(self):
        s.cmd_on('x','y',True)
        self.rc.CreateInstances.assert_not_called()
        env=self.set_function_env.call_args.args[1]
        self.assertEqual(env['KEEP'],'retained');self.assertEqual(env['REDIS_HOST'],'10.0.0.8')
        self.assertEqual(env['REDIS_PORT'],'6379');self.gh_set_var.assert_called_once_with('SENTINEL_MODE','on')
    def test_failed_smoke_does_not_enable_monitor(self):
        self.smoke.return_value=False
        with self.assertRaises(SystemExit):s.cmd_on('x','y',True)
        self.gh_set_var.assert_not_called()
    def test_create_uses_canonical_network_and_single_real_request(self):
        self.find.return_value=None;self.rc.CreateInstances.return_value=NS(InstanceIds=['crs-new'])
        seen=[];self.rc.CreateInstances.side_effect=lambda req:(seen.append(json.loads(req.to_json_string())) or NS(InstanceIds=['crs-new']))
        with patch.object(s,'wait_redis_ready',return_value=self.inst):s.cmd_on('x','y',True)
        self.assertEqual([x['DryRun'] for x in seen],[True,False]);self.assertEqual(seen[0]['VpcId'],'vpc-test')
        self.assertEqual(seen[0]['SubnetId'],'subnet-test');self.assertEqual(seen[0]['MemSize'],256)
        self.assertNotIn('fake-test-secret',self.snap.read_text());self.assertEqual(json.loads(self.snap.read_text())['instanceId'],'crs-new')
    def test_creation_failure_never_updates_function(self):
        self.find.return_value=None;self.rc.CreateInstances.side_effect=[NS(),RuntimeError('payment failed')]
        with self.assertRaises(RuntimeError):s.cmd_on('x','y',True)
        self.set_function_env.assert_not_called();self.gh_set_var.assert_not_called()
    def test_preflight_failure_never_places_order(self):
        self.find.return_value=None;self.rc.CreateInstances.side_effect=RuntimeError('invalid')
        with self.assertRaises(RuntimeError):s.cmd_on('x','y',True)
        self.assertEqual(self.rc.CreateInstances.call_count,1)
        self.assertTrue(self.rc.CreateInstances.call_args.args[0].DryRun)
    def test_isolated_instance_never_duplicates(self):
        self.inst['Status']=-2
        with self.assertRaises(SystemExit):s.cmd_on('x','y',True)
        self.rc.CreateInstances.assert_not_called()
    def test_off_snapshot_preserves_spec_without_secret(self):
        self.rc.DescribeInstances.return_value=NS(InstanceSet=[])
        s.cmd_off('x','y',True)
        saved=json.loads(self.snap.read_text());self.assertEqual(saved['replicas'],1)
        self.assertEqual(saved['typeId'],17);self.assertEqual(saved['vpc'],'vpc-test')
        self.assertNotIn('fake-test-secret',self.snap.read_text())
        self.rc.DestroyPostpaidInstance.assert_called_once();self.gh_set_var.assert_called_once_with('SENTINEL_MODE','off')
    def test_off_refuses_prepaid_instance(self):
        self.inst['BillingMode']=1
        with self.assertRaises(SystemExit):s.cmd_off('x','y',True)
        self.rc.DestroyPostpaidInstance.assert_not_called()
    def test_off_refuses_network_mismatch(self):
        self.inst['UniqVpcId']='vpc-other'
        with self.assertRaises(SystemExit):s.cmd_off('x','y',True)
        self.rc.DestroyPostpaidInstance.assert_not_called()
    def test_missing_snapshot_never_creates(self):
        self.find.return_value=None;self.snap.unlink()
        with self.assertRaises(SystemExit):s.cmd_on('x','y',True)
        self.rc.CreateInstances.assert_not_called()

    def test_monitor_failure_does_not_block_off(self):
        self.gh_set_var.side_effect=RuntimeError('github unavailable')
        self.rc.DescribeInstances.return_value=NS(InstanceSet=[])
        self.assertEqual(s.cmd_off('x','y',True),2)
        self.rc.DestroyPostpaidInstance.assert_called_once()
    def test_uncertain_delete_checks_state_without_resubmitting(self):
        from tencentcloud.common.exception.tencent_cloud_sdk_exception import TencentCloudSDKException
        self.rc.DestroyPostpaidInstance.side_effect=TencentCloudSDKException('ClientNetworkError','lost response')
        self.rc.DescribeInstances.return_value=NS(InstanceSet=[])
        self.assertEqual(s.cmd_off('x','y',True),0)
        self.rc.DestroyPostpaidInstance.assert_called_once()
    def test_rejected_delete_restores_monitor(self):
        self.rc.DestroyPostpaidInstance.side_effect=RuntimeError('rejected')
        with self.assertRaises(RuntimeError):s.cmd_off('x','y',True)
        self.assertEqual([c.args[1] for c in self.gh_set_var.call_args_list],['off','on'])
    def test_status_returns_redis_result_when_function_unavailable(self):
        self.sc.GetFunction.side_effect=RuntimeError('unavailable')
        self.assertEqual(s.cmd_status('x','y'),2)
    def test_cancellation_is_distinct_and_no_changes(self):
        with patch('builtins.input',return_value='no'):
            self.assertEqual(s.cmd_off('x','y',False),3)
        self.rc.DestroyPostpaidInstance.assert_not_called();self.gh_set_var.assert_not_called()

class SelectionTests(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup)
        patcher=patch.object(s,"LOG",Path(temp.name)/"test.log");patcher.start();self.addCleanup(patcher.stop)
    def item(self,name,i,status=2):
        return NS(InstanceName=name,InstanceId=i,Status=status,_serialize=lambda:dict(InstanceId=i,Status=status))
    def test_paginates_and_ignores_unrelated_instances(self):
        cl=Mock();cl.DescribeInstances.side_effect=[NS(InstanceSet=[self.item('other','crs-other')],TotalCount=2),NS(InstanceSet=[self.item('beichen-state-redis','crs-target')],TotalCount=2)]
        self.assertEqual(s.find_instance(cl)['InstanceId'],'crs-target')
        self.assertEqual(cl.DescribeInstances.call_args.args[0].Offset,1)
    def test_duplicate_names_fail_closed(self):
        cl=Mock();cl.DescribeInstances.return_value=NS(InstanceSet=[self.item('beichen-state-redis','crs-1'),self.item('beichen-state-redis','crs-2')],TotalCount=2)
        with self.assertRaises(SystemExit):s.find_instance(cl)
    def test_deleted_ignored_isolated_retained(self):
        cl=Mock();cl.DescribeInstances.return_value=NS(InstanceSet=[self.item('beichen-state-redis','crs-old',-3),self.item('beichen-state-redis','crs-isolated',-2)],TotalCount=2)
        self.assertEqual(s.find_instance(cl)['InstanceId'],'crs-isolated')
    def test_wait_supports_sdk_wanip_without_vip(self):
        cl=Mock();i=self.item('beichen-state-redis','crs-target');i.WanIp='10.0.0.1'
        cl.DescribeInstances.return_value=NS(InstanceSet=[i])
        with patch.object(s.time,'sleep'):self.assertEqual(s.wait_redis_ready(cl,'crs-target')['InstanceId'],'crs-target')
        self.assertEqual(cl.DescribeInstances.call_args.args[0].InstanceId,'crs-target')

class ReliabilityTests(unittest.TestCase):
    def test_network_read_recovers(self):
        from tencentcloud.common.exception.tencent_cloud_sdk_exception import TencentCloudSDKException
        operation=Mock(side_effect=[TencentCloudSDKException('ClientNetworkError','secret-payload'),42])
        with patch.object(s.time,'sleep'),patch.object(s,'say'):
            self.assertEqual(s.read_call(operation,None),42)
        self.assertEqual(operation.call_count,2)
    def test_permanent_error_not_retried(self):
        operation=Mock(side_effect=RuntimeError('permanent'))
        with self.assertRaises(RuntimeError):s.read_call(operation,None)
        self.assertEqual(operation.call_count,1)
    def test_github_timeout_then_success(self):
        with patch.object(s.subprocess,'run',side_effect=[s.subprocess.TimeoutExpired('gh',15),NS(returncode=0)]) as run,patch.object(s.time,'sleep'),patch.object(s,'say'):
            s.gh_set_var('SENTINEL_MODE','off')
        self.assertEqual(run.call_count,2)
    def test_cli_logs_no_exception_payload(self):
        with tempfile.TemporaryDirectory() as d,patch.object(s,'LOG',Path(d)/'run.log'),patch.object(s,'main',side_effect=RuntimeError('SECRET_MUST_NOT_APPEAR')),patch.object(s,'operation_lock',contextlib.nullcontext):
            self.assertEqual(s.run_cli(),1)
            self.assertNotIn('SECRET_MUST_NOT_APPEAR',(Path(d)/'run.log').read_text(encoding='utf-8'))
    def test_second_process_lock_is_rejected(self):
        with s.operation_lock():
            with self.assertRaises(SystemExit):
                with s.operation_lock():pass

if __name__=='__main__':unittest.main(verbosity=2)
