"""功能概述：真实 broker/helper/单 Chromium owner 的 DOM、选择控件、未知回执和持久下载验证。
代码库关系：供 check-browser-container 调用；网站 ledger 位于独立 Node 进程，不依赖工具回执；覆盖动态表单与旧观察。
输入输出与副作用：固定合成站点和随机操作；handoff/recover 均走 Broker，最后停止站点进程。
"""
import base64
from datetime import datetime, timedelta, timezone
import hashlib
import json
import time
import uuid

from broker import BrokerError


def until(read, predicate, seconds=10):
    deadline = time.monotonic() + seconds
    while True:
        value = read()
        if predicate(value):
            return value
        if time.monotonic() >= deadline:
            raise AssertionError({'browserConditionTimeout': value})
        time.sleep(0.02)


def check_browser(broker, key, command):
    backend = broker.backend
    container = broker.environments[key]['container']
    command('exec', '--detach', container, '/usr/local/bin/node', '/opt/kaguya-tools/browser-site.mjs')
    def read_private(name):
        value = command('exec', container, '/usr/local/bin/node', '-e',
                        "const f=require('fs');const p='/private/browser-site-" + name + ".json';process.stdout.write(f.existsSync(p)?f.readFileSync(p):'null')")
        return json.loads(value)
    site = until(lambda: read_private('ready'), lambda value: value is not None)
    binding = broker.acquire({'environmentId': key, 'scope': 'ci', 'workflowId': 'browser-flow', 'ttlSeconds': 120})
    def request(tool, arguments):
        identity = uuid.uuid4().hex
        return {'intentId': identity, 'operationId': identity, 'attemptId': identity, 'digest': identity,
                'environment': binding['environment'], 'token': binding['token'], 'scope': 'ci',
                'toolName': tool, 'arguments': arguments, 'target': {},
                'deadline': (datetime.now(timezone.utc) + timedelta(seconds=30)).isoformat()}
    def execute(tool, arguments):
        req = request(tool, arguments)
        result = broker.execute(req)
        assert result['status'] == 'succeeded', result
        return req, result
    def observe():
        return execute('browser.observe', {})[1]['result']
    def node(state, name):
        return next(item['id'] for item in state['nodes'] if item['name'] == name)
    def health():
        return backend.collect(backend.launch(broker.environments[key], {'helperProtocolVersion': 1, 'kind': 'health'}), 15)
    try:
        initial = observe()
        _, nav = execute('browser.act', {'observation': initial['observation'], 'action': 'navigate', 'url': site['url']})
        assert nav['result']['dispatched'] is True
        current = until(observe, lambda state: any(item['name'] == 'unsaved' for item in state['nodes']))
        target = current['pageId']
        for size in (4096, 4097, 32768):
            value = 'x' * size
            _, filled = execute('browser.act', {'observation': current['observation'], 'action': 'fill', 'nodeId': node(current, 'unsaved'), 'value': value})
            current = observe()
            _, checked = execute('browser.verify', {'mode': 'page', 'original': filled['result']['original'], 'observation': current['observation'], 'expectation': {'kind': 'value', 'nodeId': node(current, 'unsaved'), 'equals': value}})
            assert checked['result']['matched'] is True
        assert next(item for item in current['nodes'] if item['name'] == 'fieldset disabled')['disabled'] is True
        assert next(item for item in current['nodes'] if item['name'] == 'agree')['checked'] is False
        _, checked_click = execute('browser.act', {'observation': current['observation'], 'action': 'click', 'nodeId': node(current, 'agree')})
        current = observe()
        assert next(item for item in current['nodes'] if item['name'] == 'agree')['checked'] is True
        _, checked_state = execute('browser.verify', {'mode': 'page', 'original': checked_click['result']['original'], 'observation': current['observation'], 'expectation': {'kind': 'checked', 'nodeId': node(current, 'agree'), 'equals': True}})
        assert checked_state['result']['matched'] is True and checked_state['result']['actual'] is True
        assert next(item for item in current['nodes'] if item['name'] == 'first choice')['checked'] is True
        assert next(item for item in current['nodes'] if item['name'] == 'second choice')['checked'] is False
        _, radio_click = execute('browser.act', {'observation': current['observation'], 'action': 'click', 'nodeId': node(current, 'second choice')})
        current = observe()
        for name, expected in (('first choice', False), ('second choice', True)):
            assert next(item for item in current['nodes'] if item['name'] == name)['checked'] is expected
            _, radio_state = execute('browser.verify', {'mode': 'page', 'original': radio_click['result']['original'], 'observation': current['observation'], 'expectation': {'kind': 'checked', 'nodeId': node(current, name), 'equals': expected}})
            assert radio_state['result']['matched'] is True and radio_state['result']['actual'] is expected
        execute('browser.act', {'observation': current['observation'], 'action': 'select', 'nodeId': node(current, 'dynamic choice'), 'value': 'b'})
        current = until(observe, lambda state: any(item['tag'] == 'output' and item['text'] == 'selected b' for item in state['nodes']))
        execute('browser.act', {'observation': current['observation'], 'action': 'fill', 'nodeId': node(current, 'unsaved'), 'value': 'retain-me'})
        current = observe()
        assert next(item['value'] for item in current['nodes'] if item['name'] == 'unsaved') == 'retain-me'
        click_req, click = execute('browser.act', {'observation': current['observation'], 'action': 'click', 'nodeId': node(current, 'submit once')})
        # 同 operation 原样重试仅取宿主 journal，不再次调用 helper。
        assert broker.execute(click_req) == click
        current = until(observe, lambda state: any(item['tag'] == 'output' and item['text'] == '1' for item in state['nodes']))
        assert read_private('ledger')['submissions'] == 1
        count = next(item for item in current['nodes'] if item['tag'] == 'output' and item['text'] == '1')
        _, verified = execute('browser.verify', {'mode': 'page', 'original': click['result']['original'], 'observation': current['observation'], 'expectation': {'kind': 'text', 'nodeId': count['id'], 'equals': '1'}})
        assert verified['evidence'] == 'returned' and verified['result']['matched'] is True
        assert verified['result']['verificationKind'] == 'current-page-state' and verified['result']['causalAttribution'] == 'unconfirmed'
        _, downloaded = execute('browser.act', {'observation': current['observation'], 'action': 'click', 'nodeId': node(current, 'download CSV')})
        current = until(observe, lambda state: any(item['state'] == 'completed' for item in state['downloads']))
        file = next(item for item in current['downloads'] if item['state'] == 'completed')
        expected = b'name,value\nkaguya,42\n'
        assert file['sha256'] == hashlib.sha256(expected).hexdigest()
        _, exported = execute('browser.verify', {'mode': 'download', 'verificationKind': 'current-file-state', 'original': downloaded['result']['original'], 'observation': current['observation'], 'downloadId': file['id'], 'sha256': file['sha256']})
        assert exported['result']['verificationKind'] == 'current-file-state' and exported['result']['causalAttribution'] == 'unconfirmed'
        artifact = exported['artifacts'][0]
        payload = broker.read_artifact({'scope': 'ci', 'id': artifact['id']})
        assert base64.b64decode(payload['dataBase64']) == expected
        old_observation = current['observation']
        old_lease_request = request('browser.observe', {})
        before = health()
        control = {'environmentId': key, 'scope': 'ci', 'generation': 0, 'controlAuthorizationId': uuid.uuid4().hex}
        human = broker.handoff(control)
        assert human['state'] == 'human'
        assert health()['executors'][0]['ownerPid'] == before['executors'][0]['ownerPid']
        broker.resume({**control, 'generation': 1, 'controlAuthorizationId': uuid.uuid4().hex})
        binding = broker.acquire({'environmentId': key, 'scope': 'ci', 'workflowId': 'resumed-flow', 'ttlSeconds': 120})
        try:
            broker.execute(old_lease_request)
        except BrokerError as error:
            assert str(error) == 'stale-environment', error
        else:
            raise AssertionError('old lease accepted after handoff')
        try:
            broker.execute(request('browser.act', {'observation': old_observation, 'action': 'click', 'nodeId': 'n0'}))
        except BrokerError as error:
            assert str(error) == 'stale-observation', error
        else:
            raise AssertionError('old observation accepted after handoff')
        current = observe()
        assert current['pageId'] == target
        assert any(item.get('value') == 'retain-me' for item in current['nodes'])
        assert any(item['text'] == site['nonce'] for item in current['nodes'])
        assert read_private('ledger')['submissions'] == 1
        # CSSOM 改动不改变 outerHTML：旧观察仍须在 renderer 激活边界检查当前可见性。
        old_css = current
        fresh_css = observe()
        execute('browser.act', {'observation': fresh_css['observation'], 'action': 'click', 'nodeId': node(fresh_css, 'hide submit')})
        hidden = observe()
        assert hidden['contentHash'] == old_css['contentHash']
        blocked = broker.execute(request('browser.act', {'observation': old_css['observation'], 'action': 'click', 'nodeId': node(old_css, 'submit once')}))
        assert blocked['status'] == 'partial' and blocked['result']['dispatched'] is False, blocked
        assert blocked['result']['reason'] == 'node-actionability-changed'
        assert read_private('ledger')['submissions'] == 1
        execute('browser.act', {'observation': hidden['observation'], 'action': 'click', 'nodeId': node(hidden, 'show submit')})
        current = observe()
        # 先让真实站点 fsync 第二次提交，再丢弃 collector 回执；未知不能重跑。
        lost = request('browser.act', {'observation': current['observation'], 'action': 'click', 'nodeId': node(current, 'submit once')})
        collect = backend.collect
        def lose_ack(handle, timeout):
            raw = collect(handle, timeout)
            if isinstance(handle, tuple) and json.loads(handle[1]).get('operationId') == lost['operationId']:
                assert raw['result']['dispatched'] is True
                until(lambda: read_private('ledger'), lambda value: value['submissions'] == 2)
                raise BrokerError('synthetic-ack-loss-after-durable-submit')
            return raw
        backend.collect = lose_ack
        try:
            unknown = broker.execute(lost)
        finally:
            backend.collect = collect
        assert unknown['status'] == 'unknown'
        broker.takeover({'environmentId': key, 'scope': 'ci', 'generation': 2, 'controlAuthorizationId': uuid.uuid4().hex})
        binding = broker.acquire({'environmentId': key, 'scope': 'ci', 'workflowId': 'verified-flow', 'ttlSeconds': 120})
        reconciled = broker.reconcile({**lost, 'token': binding['token'], 'controlEnvironment': binding['environment'], 'controlAuthorizationId': uuid.uuid4().hex})
        assert reconciled['status'] == 'unknown'
        launch = backend.launch
        repeated_dispatches = []
        def record_repeated_dispatch(env, body):
            repeated_dispatches.append(body.get('operationId'))
            return launch(env, body)
        backend.launch = record_repeated_dispatch
        try:
            try:
                broker.execute({**lost, 'environment': binding['environment'], 'token': binding['token']})
            except BrokerError as error:
                assert str(error) == 'operation-conflict'
            else:
                raise AssertionError('unknown operation was accepted for replay under a new generation')
            assert repeated_dispatches == []
        finally:
            backend.launch = launch
        current = until(observe, lambda state: any(item['tag'] == 'output' and item['text'] == '2' for item in state['nodes']))
        count = next(item for item in current['nodes'] if item['tag'] == 'output' and item['text'] == '2')
        _, actual = execute('browser.verify', {'mode': 'page', 'original': {'operationId': lost['operationId'], 'attemptId': lost['attemptId']}, 'observation': current['observation'], 'expectation': {'kind': 'text', 'nodeId': count['id'], 'equals': '2'}})
        assert actual['result']['matched'] is True
        assert read_private('ledger')['submissions'] == 2
        assert broker.reconcile({**lost, 'token': binding['token'], 'controlEnvironment': binding['environment'], 'controlAuthorizationId': uuid.uuid4().hex})['status'] == 'unknown'
        print(json.dumps({'provider': 'actual-broker-helper-single-owner', 'submissions': 2, 'cssomHiddenTargetDidNotActivate': True, 'firstOperationJournalReplayDidNotClick': True, 'lostAckOriginalRemainsUnknown': True, 'newOperationVerifiedRealCount': 2, 'download': file, 'retainedTarget': target, 'retainedOwner': before['executors'][0], 'unsavedValueRetained': True, 'domNonceRetained': True}), flush=True)
    finally:
        command('exec', container, '/usr/local/bin/node', '-e', 'process.kill(' + str(site['pid']) + ', "SIGTERM")')
