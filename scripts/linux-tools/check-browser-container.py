#!/usr/bin/env python3
"""功能概述：在 CI 按 W6 生产参数创建可信 browser 容器，执行 Chromium 自身 sandbox 门禁。
代码库关系：复用 Broker/PodmanBackend；命令固定为合成 browser-probe，不接收用户 argv。
输入输出与副作用：随机环境、临时 broker 根目录，finally 回收容器/volume，保留原始 Chromium 错误。
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'linux-environments'))
from broker import Broker, PodmanBackend, digest
from browser_checks import check_browser

parser = argparse.ArgumentParser()
parser.add_argument('--archive', required=True)
parser.add_argument('--digest', required=True)
args = parser.parse_args()
backend = PodmanBackend()
backend.env = {k: v for k, v in os.environ.items() if k in ('HOME', 'PATH', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS')}
backend.env.setdefault('XDG_RUNTIME_DIR', f'/run/user/{os.getuid()}')
class PodmanCommandError(RuntimeError):
    def __init__(self, stderr):
        super().__init__('podman-command-failed')
        self.stderr = stderr.decode(errors='replace')
def command(*parts, timeout=30, diagnostics=False):
    result = subprocess.run(['/usr/bin/podman', *parts], env=backend.env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    if result.returncode or diagnostics:
        print(result.stderr.decode(errors='replace'), file=sys.stderr)
    if result.returncode:
        raise PodmanCommandError(result.stderr)
    return result.stdout
backend.command = command
info = json.loads(command('info', '--format=json'))
assert info['host']['security']['rootless'] is True
default_profile = Path(info['host']['security']['seccompProfilePath']).read_bytes()
print(json.dumps({'runtimeSecurity': info['host']['security'], 'hostDefaultSeccompSha256': hashlib.sha256(default_profile).hexdigest(), 'hostDefaultChrootRules': [r for r in json.loads(default_profile)['syscalls'] if 'chroot' in r['names']]}), flush=True)
command('load', '--input', str(Path(args.archive).resolve()), timeout=300)
image = 'localhost/kaguya-chromium@' + args.digest
assert json.loads(command('image', 'inspect', image))[0]['Digest'] == args.digest
key = 'browser-ci-' + uuid.uuid4().hex
with tempfile.TemporaryDirectory() as root:
    broker = Broker(root, backend)
    try:
        default_key = key + '-default'
        broker.create({'environmentId': default_key, 'scope': 'ci', 'workspaceId': default_key,
                       'resourceIds': [default_key], 'image': image, 'network': 'none'})
        baseline = broker.environments[default_key]
        try:
            command('exec', baseline['container'], '/usr/local/bin/node', '/opt/kaguya-tools/browser-probe.mjs', timeout=60, diagnostics=True)
        except PodmanCommandError as error:
            assert 'sys_chroot("/proc/self/fdinfo/") == 0' in error.stderr, error.stderr
            print(json.dumps({'defaultPolicy': 'failed-at-chroot', 'imageDigest': args.digest}), flush=True)
        else:
            raise AssertionError('default policy unexpectedly passed; review the A/B premise')
        env = broker.create({'environmentId': key, 'scope': 'ci', 'workspaceId': key,
                             'resourceIds': [key], 'image': image, 'network': 'none', 'sandboxPolicy': 'chromium-v1'})
        internal = broker.environments[key]
        desktop = json.loads(command('inspect', internal['container']))[0]
        oci = json.loads(command('unshare', '/bin/cat', desktop['OCIConfigPath']))
        assert oci['process']['user']['uid'] == 1000 and oci['process']['noNewPrivileges'] is True
        assert all(not values for values in oci['process']['capabilities'].values())
        assert oci['root']['readonly'] is True and oci['linux']['seccomp']['defaultAction'] == 'SCMP_ACT_ERRNO'
        print(json.dumps({'desktopPolicy': oci['linux'], 'desktopProcess': oci['process']}), flush=True)
        result = command('exec', internal['container'], '/usr/local/bin/node', '/opt/kaguya-tools/browser-probe.mjs', timeout=60, diagnostics=True)
        selected_profile = backend.chromium_profile()
        print(json.dumps({'imageDigest': args.digest, 'runtime': info['version'], 'sandboxPolicy': internal['sandboxPolicy'], 'seccompProfile': selected_profile.name, 'seccompSha256': hashlib.sha256(selected_profile.read_bytes()).hexdigest(), 'browser': json.loads(result)}), flush=True)
        check_browser(broker, key, command)
    except BaseException:
        for internal in broker.environments.values():
            try:
                print(command('logs', internal['container']).decode(errors='replace'), file=sys.stderr)
            except Exception as diagnostics:
                print(repr(diagnostics), file=sys.stderr)
        raise
    finally:
        primary = sys.exc_info()[1]
        failures = []
        try:
            broker.close()
        except Exception as error:
            failures.append(error)
        for env in broker.environments.values():
            try:
                command('rm', '--force', '--ignore', env['container'])
            except Exception as error:
                failures.append(error)
            for prefix, identity in (('kaguya-workspace-', env['workspaceId']), ('kaguya-private-', env['environmentId'])):
                try:
                    command('volume', 'rm', '--force', prefix + digest(identity)[:24])
                except Exception as error:
                    failures.append(error)
            try:
                backend.shell.system('/usr/bin/systemctl', '--user', 'stop', backend.shell.slice(env))
            except Exception as error:
                failures.append(error)
        if failures:
            raise BaseExceptionGroup('browser fixture cleanup failed', ([primary] if primary else []) + failures)
