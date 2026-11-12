#!/usr/bin/env python3
"""功能：用两个新建专属 PG17 容器验证非空备份、scratch 恢复、增量迁移与兼容回退。
main 只使用已缓存 postgres:17-alpine，创建独立数据库，源库与恢复库有不同system identifier。
schema_seed 调用当前数据层阶段并留下待迁移media阶段；SEED_SQL放入synthetic raw/epoch/
revision/queue/unknown/TTS事实。迁移后添加真实bytea媒体及冻结输入，验证第二次完整恢复。
关系：复用 recovery.py 指纹与rollback-check，不模拟生产systemd或cgroup验收；离线入口
通过tsx运行当前源码。所有命令/输出/数据是本机合成数据，独立证据目录0600保存。
不会启动Runtime/模型/平台；finally只停止本次创建的容器，保留容器和数据供审核。
"""
import argparse
import base64
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import uuid
from urllib.parse import quote

LOG_ROOT = None
CREATED_CONTAINERS = []

def require(ok, code):
    if not ok:
        raise RuntimeError(code)

def run(args, *, data=None, stdin=None, stdout=None, env=None):
    result = subprocess.run(list(map(str, args)), input=data, stdin=stdin, stdout=stdout or subprocess.PIPE,
                            stderr=subprocess.PIPE, env=env, check=False, timeout=300)
    if result.returncode:
        if LOG_ROOT is not None:
            token = uuid.uuid4().hex[:10]
            (LOG_ROOT / (token + '.stderr')).write_bytes(result.stderr or b'')
            (LOG_ROOT / (token + '.stdout')).write_bytes(result.stdout or b'')
        raise RuntimeError('command-failed:' + Path(str(args[0])).name)
    if len(args)>2 and str(args[0])=='docker' and args[1]=='run' and '--name' in args:
        CREATED_CONTAINERS.append(str(args[list(args).index('--name')+1]))
    return result.stdout

def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def save(path, data):
    path = Path(path)
    with path.open('x', encoding='utf8') as f:
        os.chmod(path, 0o600)
        json.dump(data, f, ensure_ascii=False, sort_keys=True, indent=2)
        f.write('\n')

def wrapper_dir(root, container):
    root.mkdir(mode=0o700)
    # 只转发调用方显式给出的 PG 环境；每个工具在独立 scratch 容器内运行。
    program = '''#!/usr/bin/env python3
import os,sys
from pathlib import Path
name=Path(sys.argv[0]).name
assert name in ('psql','pg_dump','pg_dumpall','pg_restore')
cmd=['docker','exec','-i','-u','0']
for key,value in os.environ.items():
    if key.startswith('PG'): cmd += ['-e',key+'='+value]
cmd += [CONTAINER,'/usr/local/bin/'+name,*sys.argv[1:]]
os.execvpe('docker',cmd,os.environ)
'''.replace('CONTAINER', repr(container))
    for name in ('psql', 'pg_dump', 'pg_dumpall', 'pg_restore'):
        path = root / name
        path.write_text(program)
        path.chmod(0o700)
    return root

def wait_ready(container, user, database):
    deadline = time.monotonic() + 60
    while True:
        result = subprocess.run(['docker','exec',container,'pg_isready','-q','-h','127.0.0.1','-U',user,'-d',database],
                                stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=10)
        if result.returncode == 0:
            return
        require(time.monotonic() < deadline, 'cluster-start-timeout')
        time.sleep(0.1)

def exec_sql(container, database, sql, user='postgres'):
    return run(['docker', 'exec', '-i', '-u', '0', container, 'psql', '-X', '-w', '-qAt',
                '-v', 'ON_ERROR_STOP=1', '-U', user, '-d', database, '-c', sql]).decode().strip()

def schema_seed(repo, node, url):
    # 分别调用既有阶段，刻意不调用新的 prepareMediaSourceSchema；没有 DROP 或旧库改造。
    body = r'''
import {pathToFileURL} from 'node:url';
const repo=process.env.SPRINT_REPO;
const mod=async p=>import(pathToFileURL(repo+'/'+p).href);
const {PgDatabase}=await mod('packages/database/src/driver.ts');
const {prepareDatabaseSchema}=await mod('packages/database/src/schema.ts');
const {prepareObservationSchema}=await mod('packages/database/src/observation-schema.ts');
const {prepareActionSchema}=await mod('packages/database/src/action-store.ts');
const {prepareNativeToolSchema}=await mod('packages/database/src/native-tool-store.ts');
const {prepareNativeMemoryToolSchema}=await mod('packages/database/src/native-memory-tools.ts');
const {InformationRepository}=await mod('packages/database/src/information-repository.ts');
const {offlineKinds}=await mod('apps/server/src/offline-upgrade.ts');
const tts=await mod('examples/plugins/qwen-tts/index.mjs');
const sql=await PgDatabase.connect({connectionString:process.env.SPRINT_URL});
try {
  const existing=await sql.query('SELECT count(*)::int n FROM pg_tables WHERE schemaname=\'public\'');
  if(existing.rows[0].n!==0) throw Error('new-fixture-database-required');
  for(const prepare of [prepareDatabaseSchema,prepareObservationSchema,prepareActionSchema,prepareNativeToolSchema,prepareNativeMemoryToolSchema]) await prepare(sql);
  const added=new Set(['core.message.assistant.authorized','agent.heavy.message.draft','agent.heavy.message.prepared']);
  const definitions=[...offlineKinds().filter(d=>!added.has(d.kind)),...Object.values(tts).filter(d=>d && typeof d==='object' && typeof d.kind==='string' && d.kind.startsWith('agent.tts.') && d.persistence)];
  await new InformationRepository(sql).synchronizeKinds(definitions.map(d=>d.kind),definitions);
} finally {await sql.close();}
'''
    env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
    env.update(SPRINT_REPO=str(repo), SPRINT_URL=url)
    run([node, '--import', 'tsx', '--input-type=module'], data=body.encode(), env=env)

SEED_SQL = r'''
BEGIN;
INSERT INTO information_atoms(information_id,kind,occurred_at,source,payload) VALUES
('scratch:source','agent.tts.requested.v1','2026-11-07T00:00:00.000Z','synthetic:deployment','{"text":"合成来源"}'),
('scratch:revision','memory.native.revision.v1','2026-11-07T00:00:01.000Z','synthetic:deployment','{"revision":2,"invalidations":[]}'),
('scratch:rejected','agent.tts.requested.v1','2026-11-07T00:00:02.000Z','synthetic:deployment','{"text":"合成拒绝哨兵"}');
INSERT INTO information_references VALUES('scratch:revision',0,'core:caused-by','scratch:source');
INSERT INTO information_lifecycle(information_id,kind,scope_key,occurred_at,is_open)
SELECT information_id,kind,'synthetic:deployment',occurred_at::timestamptz,false FROM information_atoms;
INSERT INTO information_log_outbox(information_id) SELECT information_id FROM information_atoms;
INSERT INTO information_subscriptions(subscription_id,kind,enabled) VALUES('scratch:consumer','agent.tts.requested.v1',true);
INSERT INTO information_deliveries(subscription_id,information_id,state,attempts) VALUES('scratch:consumer','scratch:source','pending',2);
INSERT INTO information_commit_slots VALUES('operation','synthetic:deployment','one','scratch:source');
INSERT INTO memory_raw_events(information_id,kind,payload,"references",scope,scope_key,occurred_at,position,is_semantic)
SELECT a.information_id,a.kind,a.payload,'[]','{"synthetic":true}','synthetic:deployment',a.occurred_at::timestamptz,l.position,true
FROM information_atoms a JOIN information_lifecycle l USING(information_id) WHERE a.information_id='scratch:source';
INSERT INTO memory_raw_rejections SELECT 'scratch:rejected',position FROM information_lifecycle WHERE information_id='scratch:rejected';
UPDATE memory_raw_checkpoint SET position=(SELECT max(position) FROM information_lifecycle) WHERE singleton;
UPDATE memory_native_epoch SET started_at='2026-11-06T00:00:00Z',source_after=0 WHERE id;
INSERT INTO memory_nodes VALUES
('00000000-0000-4000-8000-000000000001','{"system":"native-v1","level":"1","status":"active","revision":2,"scope":"synthetic:deployment","ownerId":"synthetic"}','合成修订正文'),
('00000000-0000-4000-8000-000000000002','{"synthetic":true,"revision":1}','合成来源正文');
INSERT INTO memory_edges VALUES('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','supported_by','{}');
INSERT INTO memory_native_sources(id,scope,source) VALUES('scratch:source','synthetic:deployment','{"informationId":"scratch:source"}');
INSERT INTO memory_native_publications(operation_id,input_hash,information_id,nodes)
VALUES('scratch:publication','synthetic-input-hash','scratch:revision','["00000000-0000-4000-8000-000000000001"]');
INSERT INTO memory_native_tool_outputs VALUES('scratch:tool','synthetic-input-hash','{"revision":2,"synthetic":true}');
INSERT INTO information_action_heads(intent_id,operation_id,input,digest,state,legacy_delivery)
VALUES('scratch:source','scratch:unknown-action','{"synthetic":true}','synthetic-digest','unknown',true);
COMMIT;
'''

def dump(pg, directory):
    directory.mkdir(mode=0o700)
    for name, command, args in [
        ('database.dump', 'pg_dump', ['--format=custom']),
        ('globals.sql', 'pg_dumpall', ['--globals-only']),
    ]:
        with (directory / name).open('xb') as f:
            os.chmod(f.name, 0o600)
            pg.run(command, *args, output=f)

def assert_preserved(before, after, *, kinds=False):
    for name, expected in before['tables'].items():
        if kinds and name == 'information_kinds':
            continue
        require(after['tables'][name] == expected, 'changed-table:' + name)
    require(before['sequences'] == after['sequences'], 'changed-sequence')

def config_fixture(repo, node, config, initialize=False):
    body=r"""
import {pathToFileURL} from 'node:url';
import {readFile} from 'node:fs/promises';
const {loadModuleInstanceConfigs,parseCordisTreeText}=await import(pathToFileURL(process.env.SPRINT_REPO+'/packages/config/src/index.ts').href);
const {createFirstPartyModuleConfigDefaults}=await import(pathToFileURL(process.env.SPRINT_REPO+'/packages/modules/src/index.ts').href);
if(process.env.INITIALIZE==='1') {
 const defaults=[...createFirstPartyModuleConfigDefaults().filter(c=>c.definitionId!=='agent.lifecycle'),
 {version:1,instanceId:'attention-arousal.default',definitionId:'agent.attention.arousal',enabled:true,settings:{idleSleepEnabled:false,idleSleepAfterMs:120000}},
 {version:1,instanceId:'heartbeat.default',definitionId:'agent.heartbeat.short',enabled:true,settings:{interruptQuietMs:1500}}];
 await loadModuleInstanceConfigs({rootDir:process.env.CONFIG_ROOT,defaults});
}
const tree=parseCordisTreeText(await readFile(process.env.CONFIG_ROOT+'/cordis.yml','utf8'));
process.stdout.write(JSON.stringify(tree.plugins.map(p=>p.name)));
"""
    env={**os.environ,'SPRINT_REPO':str(repo),'CONFIG_ROOT':str(config),'INITIALIZE':'1' if initialize else '0'}
    names=json.loads(run([node,'--import','tsx','--input-type=module'],data=body.encode(),env=env))
    return {'cordisSha256':digest(config/'cordis.yml'),'pluginNames':names}

def legacy_storage_probe(repo, node, root, url):
    # 执行固定SHA的原始base schema验证函数；只导出该函数，不启动旧Runtime。
    candidate = '50f01850b0afd7efc30e98c2f6ea9233c16dcaf1'
    original = run(['git','-C',repo,'show',candidate+':packages/database/src/schema.ts']).decode()
    (root/'legacy-schema-source.ts').write_text(original)
    prefix = original.split('export async function prepareDatabaseSchema(',1)[0]
    prefix = '\n'.join(line for line in prefix.splitlines() if not line.startswith('import '))
    function = original.split('async function validateCurrentSchema(',1)[1].split('/** 可重建',1)[0]
    extracted = prefix + '\nexport async function validateCurrentSchema(' + function
    validator = root/'legacy-validator.ts'; validator.write_text(extracted)
    body = r"""
import {pathToFileURL} from 'node:url';
const {PgDatabase}=await import(pathToFileURL(process.env.SPRINT_REPO+'/packages/database/src/driver.ts').href);
const {validateCurrentSchema}=await import(pathToFileURL(process.env.LEGACY_VALIDATOR).href);
const sql=await PgDatabase.connect({connectionString:process.env.SPRINT_URL,startupOptions:'-c default_transaction_read_only=on'});
try {
 const tables=await sql.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
 await validateCurrentSchema(sql,new Set(tables.rows.map(x=>x.tablename)));
 const ledger=await sql.query("SELECT information_id FROM information_atoms WHERE information_id IN ('scratch:after-upgrade','scratch:revision-after') ORDER BY information_id");
 const unknown=await sql.query("SELECT count(*)::int n FROM information_action_heads WHERE state='unknown'");
 const media=await sql.query("SELECT count(*)::int n,sum(octet_length(bytes))::int bytes FROM media_resources");
 if(ledger.rows.length!==2 || unknown.rows[0].n!==2 || media.rows[0].n!==2) throw Error('new-data-missing');
 process.stdout.write(JSON.stringify({candidateBaseSchemaAccepted:true,newLedgerRows:2,unknownActions:2,mediaResources:2,mediaBytes:media.rows[0].bytes,readOnly:true}));
} finally {await sql.close();}
"""
    env={**os.environ,'SPRINT_REPO':str(repo),'SPRINT_URL':url,'LEGACY_VALIDATOR':str(validator)}
    result=json.loads(run([node,'--import','tsx','--input-type=module'],data=body.encode(),env=env))
    result.update(candidate_sha=candidate, originalSchemaSha256=hashlib.sha256(original.encode()).hexdigest(),
                  executedValidatorSha256=digest(validator),scope='base-schema-and-read-only-storage; not old Runtime restart')
    save(root/'rollback-reader-result.json',result)
    return result


def rollback_drill(recovery, repo, node, root, target, restored, before, media, config, restore_url):
    tools=root/'tools'; tools.mkdir(mode=0o700)
    (tools/'after-upgrade.txt').write_text('synthetic new tool output retained')
    (tools/'after-upgrade.txt').chmod(0o600)
    assets={'config':config,'media':media,'tools':tools}
    baseline=target.snapshot('public')
    catalog=target.schema_fingerprint('public')
    backup=root/'rollback-backup'; dump(target,backup)
    for name,path in assets.items(): shutil.copytree(path,backup/name)
    receipt={'schema':'public','snapshot':baseline,'schemaCatalog':catalog,
             'assets':{name:recovery.tree_files(path) for name,path in assets.items()},
             'files':{name:digest(backup/name) for name in ('database.dump','globals.sql')}}
    save(backup/'receipt.json',receipt); receipt_hash=digest(backup/'receipt.json')
    recovery.verify_backup(backup,receipt_hash)
    restored_before=restored.snapshot('public')
    compatibility=legacy_storage_probe(repo,node,root,restore_url)
    assert_preserved(restored_before,restored.snapshot('public'))
    plan={'source':{'identity':target.identity()},'asset_roots':{k:str(v) for k,v in assets.items()},
          'rollback_sha':compatibility['candidate_sha']}
    compat={'backup_receipt_sha256':receipt_hash,'candidate_sha':plan['rollback_sha'],
            'verified_on_scratch':True,'pending_unknown_reconciled':True,
            'compatibility_scope':compatibility['scope'],'runtime_restart_approved':False,
            'unknown_reconciliation':'synthetic fixture only; no provider or Runtime ever ran; both unknown rows retained'}
    save(root/'rollback-compatibility.json',compat)
    result=recovery.check_rollback(plan,target,receipt,receipt_hash,compat)
    old={**receipt,'snapshot':before}
    save(root/'old-recovery-point.json',old)
    old_hash=digest(root/'old-recovery-point.json')
    old_compat={**compat,'backup_receipt_sha256':old_hash}
    rejected=[]
    try: recovery.check_rollback(plan,target,old,old_hash,old_compat)
    except recovery.Refusal as error:
        require(str(error).startswith('preserved_table_changed_') or str(error)=='preserved_sequence_changed','unexpected-old-backup-refusal:'+str(error))
        rejected.append(str(error))
    require(len(rejected)==1,'old-backup-incorrectly-accepted')
    asset=tools/'after-upgrade.txt'; original=asset.read_text(); asset.write_text('changed')
    try:
        try: recovery.check_rollback(plan,target,receipt,receipt_hash,compat)
        except recovery.Refusal as error:
            require(str(error)=='rollback_asset_changed_tools','unexpected-asset-refusal:'+str(error))
            rejected.append(str(error))
        require(len(rejected)==2,'changed-live-asset-incorrectly-accepted')
    finally: asset.write_text(original)
    recovery.check_rollback(plan,target,receipt,receipt_hash,compat)
    assert_preserved(baseline,target.snapshot('public'))
    result.update(rejected=rejected,compatibility=compatibility,latestReceiptSha256=receipt_hash)
    save(root/'rollback-result.json',result)
    return result

def main():
    entrypoint_hash = digest(Path(__file__))
    parser = argparse.ArgumentParser()
    parser.add_argument('--repo', required=True, type=Path)
    parser.add_argument('--node', required=True, type=Path)
    parser.add_argument('--directory', required=True, type=Path)
    args = parser.parse_args()
    os.environ['TSX_DISABLE_CACHE'] = '1'
    os.umask(0o077)
    repo, root, node = args.repo.resolve(strict=True), args.directory.absolute(), args.node.resolve(strict=True)
    require(not root.exists(), 'new-directory-required')
    require((repo/'apps/server/src/offline-upgrade.ts').is_file(), 'build-offline-entry-first')
    spec = importlib.util.spec_from_file_location('scratch_recovery', repo/'scripts/deployment/recovery.py')
    recovery = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(recovery)
    root.mkdir(mode=0o700)
    paths = {}
    for package in sorted((repo/'packages').glob('*/package.json')):
        metadata = json.loads(package.read_text())
        for name, export in metadata.get('exports', {}).items():
            entry = export.get('default') if isinstance(export, dict) else export
            if isinstance(entry, str) and entry.startswith('./dist/') and entry.endswith('.js'):
                source_path = package.parent / ('src/' + entry[7:-3] + '.ts')
                if source_path.is_file():
                    key = metadata['name'] + (name[1:] if name != '.' else '')
                    paths[key] = [str(source_path)]
    save(root/'tsx-config.json', {'compilerOptions': {'target':'ES2024','module':'NodeNext','moduleResolution':'NodeNext','paths':paths}})
    os.environ['TSX_TSCONFIG_PATH'] = str(root/'tsx-config.json')
    global LOG_ROOT
    LOG_ROOT = root
    suffix = uuid.uuid4().hex[:10]
    source_container = 'kaguya-deployment304-source-'+suffix
    restore_container = 'kaguya-deployment304-restore-'+suffix
    database, restored_database = 'deployment304_old', 'deployment304_media'
    image = 'postgres:17-alpine'
    image_id = run(['docker','image','inspect',image,'--format','{{.Id}}']).decode().strip()
    run(['docker','run','--pull=never','-d','--name',source_container,
         '--label','kaguya.task=deployment304','-e','POSTGRES_HOST_AUTH_METHOD=trust',
         '-p','127.0.0.1::5432',image])
    save(root/'resources.json', {'sourceContainer':source_container,'restoreContainer':restore_container,'imageId':image_id})
    wait_ready(source_container, 'postgres', 'postgres')
    source_system_id = exec_sql(source_container,'postgres','SELECT system_identifier FROM pg_control_system()')
    source_port = run(['docker','port',source_container,'5432/tcp']).decode().strip()
    require(source_port.startswith('127.0.0.1:'), 'source-not-loopback')
    source_port = int(source_port.rsplit(':',1)[1])
    exec_sql(source_container,'postgres','CREATE DATABASE '+database)
    source_url = f'postgresql://postgres@127.0.0.1:{source_port}/{database}'
    print('Preparing a new synthetic database', flush=True)
    schema_seed(repo,node,source_url)
    exec_sql(source_container,database,SEED_SQL)
    pg_env = {'PGUSER':'postgres','PGDATABASE':database,'PGHOST':'/var/run/postgresql','PGPORT':'5432'}
    source = recovery.Postgres(wrapper_dir(root/'source-bin',source_container),pg_env)
    source.idle()
    before = source.snapshot('public')
    for name in ['information_atoms','information_references','information_deliveries','information_action_heads','memory_native_epoch','memory_raw_events','memory_raw_rejections','memory_native_publications','memory_nodes','memory_native_tool_outputs']:
        require(before['tables'][name]['rows']>0, 'empty-fixture:'+name)
    source_schema = source.schema_fingerprint('public')
    original_kinds = json.loads(source.sql("SELECT json_object_agg(kind,contract) FROM information_kinds"))
    save(root/'source-snapshot.json',before)
    dump(source,root/'source-backup')
    started = False
    try:
        run(['docker','run','--pull=never','-d','--name',restore_container,
             '--label','kaguya.task=deployment304', '-e','POSTGRES_USER=sprint_restore_admin','-e','POSTGRES_DB=restore_control',
             '-e','POSTGRES_HOST_AUTH_METHOD=trust','-p','127.0.0.1::5432',
             '-v',f'{root}:{root}','postgres:17-alpine'])
        started=True
        wait_ready(restore_container, 'sprint_restore_admin', 'restore_control')
        with (root/'source-backup/globals.sql').open('rb') as f:
            run(['docker','exec','-i',restore_container,'psql','-X','-w','-v','ON_ERROR_STOP=1','-U','sprint_restore_admin','-d','restore_control'],stdin=f)
        with (root/'source-backup/database.dump').open('rb') as f:
            run(['docker','exec','-i',restore_container,'pg_restore','--exit-on-error','--create','-U','sprint_restore_admin','--dbname=restore_control'],stdin=f)
        target = recovery.Postgres(wrapper_dir(root/'restore-bin',restore_container),pg_env)
        identity=target.identity()
        require(identity['system_identifier']!=source_system_id,'independent-cluster-required')
        assert_preserved(before,target.snapshot('public'))
        require(target.schema_fingerprint('public')==source_schema,'restored-schema-changed')
        print('Restored all seeded rows and sequences into a distinct cluster',flush=True)
        port=run(['docker','port',restore_container,'5432/tcp']).decode().strip()
        require(port.startswith('127.0.0.1:'),'restore-not-loopback')
        port=int(port.rsplit(':',1)[1])
        config=root/'config'; config.mkdir(mode=0o700)
        configuration_review=config_fixture(repo,node,config,True)
        target.idle()
        dump(target,root/'migration-backup')
        common={'systemIdentifier':identity['system_identifier'],'database':database,'dataDirectory':identity['data_directory'],'configRoot':str(config)}
        receipt={**common,'files':{name:digest(root/'migration-backup'/name) for name in ['database.dump','globals.sql']}}
        save(root/'migration-backup/receipt.json',receipt)
        save(root/'stopped-receipt.json',{**common,'serviceStopped':True,'capturedAt':datetime.now(timezone.utc).isoformat()})
        offline={'connectionString':f'postgresql://postgres@127.0.0.1:{port}/{database}',
                 'expectedSystemIdentifier':identity['system_identifier'],'expectedDatabase':database,'expectedDataDirectory':identity['data_directory'],
                 'configRoot':str(config),'firstPartyOnly':True,
                 'configurationReview':configuration_review,
                 'backupReceipt':{'path':str(root/'migration-backup/receipt.json'),'sha256':digest(root/'migration-backup/receipt.json')},
                 'stoppedReceipt':{'path':str(root/'stopped-receipt.json'),'sha256':digest(root/'stopped-receipt.json')}}
        save(root/'offline-target.json',offline)
        results=[]
        for command in ['inspect','apply','verify']:
            output=run([node,'--import','tsx',repo/'apps/server/src/offline-upgrade.ts',command,'--target-file',root/'offline-target.json'])
            results.append(json.loads(output))
            if command=='apply':
                offline['configurationReview']=config_fixture(repo,node,config)
                (root/'offline-target.json').write_text(json.dumps(offline))
        migrated=json.loads((config/'modules/lifecycle.default/config.json').read_text())['settings']
        require(migrated['sleep']['idleSleepEnabled'] is False and migrated['sleep']['idleSleepAfterMs']==120000 and migrated['observation']['interruptQuietMs']==1500,'legacy-lifecycle-values-changed')
        config_after_first=recovery.tree_files(config)
        current=target.snapshot('public')
        assert_preserved(before,target.snapshot('public',before),kinds=True)
        now_kinds=json.loads(target.sql('SELECT json_object_agg(kind,contract) FROM information_kinds'))
        require(original_kinds.keys()<=now_kinds.keys(),'historical-kind-deleted')
        tts_kinds=[name for name in original_kinds if name.startswith('agent.tts.')]
        require(len(tts_kinds)==6,'tts-kinds-missing')
        require(all(original_kinds[name]==now_kinds[name] for name in tts_kinds),'historical-tts-contract-changed')
        require({'media_resources','media_sources','media_input_snapshots'}<=current['tables'].keys(),'media-stage-missing')
        for command in ['apply','verify']:
            results.append(json.loads(run([node,'--import','tsx',repo/'apps/server/src/offline-upgrade.ts',command,'--target-file',root/'offline-target.json'])))
        assert_preserved(current,target.snapshot('public'))
        require(recovery.tree_files(config)==config_after_first,'second-apply-changed-config')
        print('Offline apply/verify and second apply preserve all seeded data',flush=True)
        media=root/'media'; media.mkdir(mode=0o700)
        png=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=')
        media_sha=hashlib.sha256(png).hexdigest(); media_id='media:'+'b'*64
        resource='sha256:'+media_sha
        media_file=media/(media_sha+'.bin'); media_file.write_bytes(png); media_file.chmod(0o600)
        metadata={'mediaId':media_id,'position':0,'mediaType':'image','status':'available','resourceId':resource,'mimeType':'image/png','byteLength':len(png)}
        save(media/(media_sha+'.json'),{'resourceId':resource,'mimeType':'image/png','sha256':media_sha})
        target.sql('INSERT INTO media_resources(resource_id,mime_type,sha256,bytes) VALUES('+','.join(recovery.literal(x) for x in [resource,'image/png',media_sha])+',decode('+recovery.literal(png.hex())+",'hex'))")
        frozen=[{'kind':'text','text':'合成冻结素材'},{'kind':'media','media':metadata}]
        target.sql('INSERT INTO media_sources(media_id,scope,source_key,metadata) VALUES('+','.join(recovery.literal(x) for x in [media_id,'synthetic:deployment','synthetic-message:0',json.dumps(metadata)])+')')
        target.sql('INSERT INTO media_input_snapshots(request_key,scope,snapshot) VALUES('+','.join(recovery.literal(x) for x in ['scratch:frozen-input','synthetic:deployment',json.dumps(frozen)])+')')
        wav=b'RIFF'+(36).to_bytes(4,'little')+b'WAVEfmt '+(16).to_bytes(4,'little')+bytes.fromhex('01000100401f0000803e000002001000')+b'data'+(0).to_bytes(4,'little')
        wav_sha=hashlib.sha256(wav).hexdigest()
        target.sql('INSERT INTO media_resources(resource_id,mime_type,sha256,bytes) VALUES('+','.join(recovery.literal(x) for x in ['sha256:'+wav_sha,'audio/wav',wav_sha])+',decode('+recovery.literal(wav.hex())+",'hex'))")
        target.sql("""BEGIN;
        INSERT INTO information_atoms VALUES('scratch:after-upgrade','agent.tts.requested.v1','2026-11-07T00:01:00.000Z','synthetic:deployment','{"text":"new after upgrade"}');
        INSERT INTO information_atoms VALUES('scratch:revision-after','memory.native.revision.v1','2026-11-07T00:01:01.000Z','synthetic:deployment','{"revision":3,"invalidations":[]}');
        INSERT INTO information_lifecycle(information_id,kind,scope_key,occurred_at,is_open) SELECT information_id,kind,'synthetic:deployment',occurred_at::timestamptz,false FROM information_atoms WHERE information_id IN ('scratch:after-upgrade','scratch:revision-after');
        INSERT INTO information_log_outbox(information_id) VALUES('scratch:after-upgrade'),('scratch:revision-after');
        INSERT INTO information_deliveries(subscription_id,information_id,state,attempts) VALUES('scratch:consumer','scratch:after-upgrade','pending',1);
        INSERT INTO information_action_heads(intent_id,operation_id,input,digest,state,legacy_delivery) VALUES('scratch:after-upgrade','scratch:new-unknown','{"synthetic":true}','synthetic-new','unknown',true);
        COMMIT;""")
        with_media=target.snapshot('public'); save(root/'upgraded-media-snapshot.json',with_media)
        dump(target,root/'upgraded-media-backup')
        exec_sql(restore_container,'postgres','CREATE DATABASE '+restored_database)
        with (root/'upgraded-media-backup/database.dump').open('rb') as f:
            run(['docker','exec','-i',restore_container,'pg_restore','--exit-on-error','-U','postgres','--dbname='+restored_database],stdin=f)
        media_restore=recovery.Postgres(root/'restore-bin',{**pg_env,'PGDATABASE':restored_database})
        assert_preserved(with_media,media_restore.snapshot('public'))
        require(target.schema_fingerprint('public')==media_restore.schema_fingerprint('public'),'media-restore-schema-changed')
        shutil.copytree(media,root/'restored-media')
        require(digest(root/'restored-media'/media_file.name)==media_sha,'media-asset-changed')
        require(digest(root/'restored-media'/(media_sha+'.json'))==digest(media/(media_sha+'.json')),'media-metadata-changed')
        require(with_media['tables']['media_resources']['rows']>0,'database-media-bytes-required')
        rollback_result=rollback_drill(recovery,repo,node,root,target,media_restore,before,media,config,f'postgresql://postgres@127.0.0.1:{port}/{restored_database}')
        require(digest(Path(__file__))==entrypoint_hash,'entrypoint-changed-during-drill')
        save(root/'drill-result.json',{'entrypointSha256':entrypoint_hash,'rollbackResult':rollback_result,'sourceContainer':source_container,'sourceDatabase':database,'sourceSystemIdentifier':source_system_id,
             'restoreContainer':restore_container,'restoreDatabase':database,'restoreSystemIdentifier':identity['system_identifier'],
             'mediaRestoredDatabase':restored_database,'offlineResults':results,'sourceRows':sum(v['rows'] for v in before['tables'].values()),
             'sourceTableCounts':{name:value['rows'] for name,value in before['tables'].items()},
             'upgradedTableCounts':{name:value['rows'] for name,value in with_media['tables'].items()},
             'imageId':image_id,'sourceMode':'tsx workspace src paths; no dist imports for Kaguya packages',
             'historicalTtsKinds':tts_kinds,'scriptsSha256':{str(p.relative_to(repo)):digest(p) for p in [repo/'scripts/deployment/check_postgres_restore.py',repo/'scripts/deployment/recovery.py',repo/'apps/server/src/offline-schema.ts',repo/'apps/server/src/offline-upgrade.ts',repo/'packages/modules/src/offline-kinds.ts',repo/'packages/database/src/media-source-store.ts']},
             'firstRestoreExact':True,'oldRowsAndSequencesPreserved':True,'historicalTtsContractPreserved':True,'secondApplyExact':True,'lifecycleLegacyValuesPreserved':True,'secondConfigExact':True,
             'mediaRestoreExact':True,'mediaAssetSha256':media_sha,'runtimeStarted':False,
             'coverage':'PG17 offline API plus native dump/restore; not recovery CLI/systemd/cgroup acceptance'})
        print('Media table rows, frozen inputs, and resource bytes restored exactly',flush=True)
    finally:
        if started:
            run(['docker','stop',restore_container])
        run(['docker','stop',source_container])
        # 仅停止本次创建的两个容器；数据库及文件保留供审阅，不触其他任务。

if __name__=='__main__':
    try:
        main()
    finally:
        for name in reversed(CREATED_CONTAINERS):
            subprocess.run(['docker','stop',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=30)
