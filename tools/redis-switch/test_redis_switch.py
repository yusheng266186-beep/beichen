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
        for target,value in [('FORMAL_URL','https://example.com'),('SNAP',self.snap),('redis_client',Mock(return_value=self.rc)),('scf_client',Mock(return_value=self.sc))]:
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

class SelectionTests(unittest.TestCase):
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

if __name__=='__main__':unittest.main(verbosity=2)
