"""功能概述：以临时合成归档验证安装包校验与不可覆盖 staging，不执行 sudo、Podman 或网络。
主要职责：校验源码/镜像遗漏与篡改、包内 CI 与镜像身份不一致、复制期间变更、路径注入、符号链接和同 hash 重入。
所有错误必须在系统变更前拒绝；合成证据不代表真实 CI、Podman 或管理员安装通过。
代码库关系：直接调用生产 install_bundle.py；真实 Linux 安装由人工审核后的包另行验收。
"""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import package_bundle
import install_bundle as bundle


class BundleTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.manifest = {"version": 1, "commit": "a" * 40, "workflowRun": "https://example.invalid/run", "sources": {}, "images": {}}
        for name in bundle.SOURCE_FILES:
            (self.root / name).write_text("synthetic source " + name)
            self.manifest["sources"][name] = bundle.digest(self.root / name)
        for role in bundle.IMAGE_ROLES:
            name = role + "-tools.oci"
            (self.root / name).write_bytes(b"synthetic OCI " + role.encode())
            self.manifest["images"][role] = {"file": name, "archiveSha256": bundle.digest(self.root / name),
                                             "image": "localhost/kaguya-" + role + "@sha256:" + "b" * 64}
        self.run = {"head_sha": self.manifest["commit"], "conclusion": "success", "status": "completed", "html_url": self.manifest["workflowRun"]}
        self.receipt = {"passed": True, "existingHomeRecovered": True, "imageDigest": "sha256:" + "b" * 64}
        (self.root / "workflow-run.json").write_text(json.dumps(self.run))
        (self.root / "gui-provider-receipt.json").write_text(json.dumps(self.receipt))
        self.save()
        self.acl = patch.object(bundle, "set_broker_read_acl").start()
        self.addCleanup(patch.stopall)

    def save(self):
        (self.root / "manifest.json").write_text(json.dumps(self.manifest))

    def test_source_and_each_image_must_match(self):
        self.assertEqual(bundle.verify_manifest(self.root), self.manifest)
        (self.root / "gui-tools.oci").write_bytes(b"changed")
        with self.assertRaisesRegex(RuntimeError, "image-checksum-mismatch"):
            bundle.verify_manifest(self.root)
        # 回退不依赖镜像仍在，也必须检查原始宿主代码。
        self.assertEqual(bundle.verify_manifest(self.root, images=False), self.manifest)
        (self.root / "bootstrap.py").write_text("changed")
        with self.assertRaisesRegex(RuntimeError, "source-checksum-mismatch"):
            bundle.verify_manifest(self.root, images=False)

    def test_missing_source_and_archive_path_injection_fail_closed(self):
        source = self.manifest["sources"].pop("job_runner.py")
        self.save()
        with self.assertRaisesRegex(RuntimeError, "manifest-invalid"):
            bundle.verify_manifest(self.root)
        self.manifest["sources"]["job_runner.py"] = source
        self.manifest["images"]["gui"]["file"] = "../gui-tools.oci"
        self.save()
        with self.assertRaisesRegex(RuntimeError, "image-path-invalid"):
            bundle.verify_manifest(self.root)

    def test_stage_reuses_equal_archive_but_rejects_mutation_and_symlink(self):
        inbox = self.root / "inbox"
        inbox.mkdir()
        image = self.manifest["images"]["gui"]
        bundle.stage_image(self.root, image, inbox, 65534)
        target = inbox / (image["archiveSha256"] + ".oci")
        inode = target.stat().st_ino
        bundle.stage_image(self.root, image, inbox, 65534)
        self.assertEqual(target.stat().st_ino, inode)
        target.write_bytes(b"partial")
        with self.assertRaisesRegex(RuntimeError, "existing-inbox-checksum-mismatch"):
            bundle.stage_image(self.root, image, inbox, 65534)
        target.unlink()
        target.symlink_to(self.root / image["file"])
        with self.assertRaises(OSError):
            bundle.stage_image(self.root, image, inbox, 65534)

    def test_manifest_requires_commit_and_immutable_role_image_identity(self):
        original = copy.deepcopy(self.manifest)
        for invalid in ({}, {**original, "commit": "main"}, {**original, "sources": []}):
            with self.subTest(manifest=invalid):
                self.manifest = invalid
                self.save()
                with self.assertRaisesRegex(RuntimeError, "manifest-invalid"):
                    bundle.verify_manifest(self.root)
        for field, value in (("image", "localhost/kaguya-gui:latest"),
                             ("image", "localhost/kaguya-shell@sha256:" + "b" * 64),
                             ("archiveSha256", "../archive")):
            with self.subTest(field=field, value=value):
                self.manifest = copy.deepcopy(original)
                self.manifest["images"]["gui"][field] = value
                self.save()
                with self.assertRaisesRegex(RuntimeError, "image-identity-invalid"):
                    bundle.verify_manifest(self.root)

    def test_verify_rechecks_packaged_ci_and_gui_evidence(self):
        for field, value in (("head_sha", "c" * 40), ("status", "in_progress"), ("conclusion", "failure")):
            with self.subTest(field=field):
                (self.root / "workflow-run.json").write_text(json.dumps({**self.run, field: value}))
                with self.assertRaisesRegex(RuntimeError, "ci-not-passed"):
                    bundle.verify_manifest(self.root)
        (self.root / "workflow-run.json").write_text(json.dumps({**self.run, "html_url": "https://example.invalid/other"}))
        with self.assertRaisesRegex(RuntimeError, "ci-reference-mismatch"):
            bundle.verify_manifest(self.root)
        (self.root / "workflow-run.json").write_text(json.dumps(self.run))
        (self.root / "gui-provider-receipt.json").write_text(json.dumps({**self.receipt, "imageDigest": "sha256:" + "c" * 64}))
        with self.assertRaisesRegex(RuntimeError, "receipt-image-mismatch"):
            bundle.verify_manifest(self.root)
        (self.root / "gui-provider-receipt.json").write_text(json.dumps({**self.receipt, "passed": False}))
        with self.assertRaisesRegex(RuntimeError, "gui-provider-not-passed"):
            bundle.verify_manifest(self.root)
        # 回退仍只依赖原宿主源码；镜像和诊断证据丢失不阻止保留数据回退。
        for role in bundle.IMAGE_ROLES:
            (self.root / (role + "-tools.oci")).unlink()
        (self.root / "workflow-run.json").unlink()
        (self.root / "gui-provider-receipt.json").unlink()
        self.assertEqual(bundle.verify_manifest(self.root, images=False), self.manifest)

    def test_linked_source_is_not_accepted(self):
        path = self.root / "server.py"
        path.unlink()
        path.symlink_to(self.root / "broker.py")
        with self.assertRaisesRegex(RuntimeError, "nonregular-file"):
            bundle.verify_manifest(self.root)

    def test_package_requires_same_successful_sha_and_emits_verifiable_sources_and_images(self):
        source = self.root / "scripts/linux-environments"
        source.mkdir(parents=True)
        tools = self.root / "scripts/linux-tools"
        tools.mkdir()
        for name in bundle.SOURCE_FILES:
            (source / name).write_bytes((self.root / name).read_bytes())
        (source / "BUNDLE.md").write_text("instructions")
        (source / "README.md").write_text("host details")
        (tools / "README.md").write_text("tool details")
        artifacts = self.root / "artifacts"
        artifacts.mkdir()
        sha = "a" * 40
        run = {"head_sha": sha, "conclusion": "success", "status": "completed", "html_url": "https://example.invalid/run"}
        (artifacts / "workflow-run.json").write_text(json.dumps(run))
        evidence = artifacts / ("gui-evidence-" + sha)
        evidence.mkdir()
        (evidence / "gui-provider-receipt.json").write_text(json.dumps({"passed": True, "existingHomeRecovered": True, "imageDigest": "sha256:" + "b" * 64}))
        for role in bundle.IMAGE_ROLES:
            directory = artifacts / (role + "-tools-" + sha)
            directory.mkdir()
            image = self.manifest["images"][role]
            (directory / image["file"]).write_bytes((self.root / image["file"]).read_bytes())
            (directory / (image["file"] + ".sha256")).write_text(image["archiveSha256"] + "  " + image["file"])
            (directory / (role + "-image.digest")).write_text("sha256:" + "b" * 64)
        output = self.root / "bundle"
        with patch.object(package_bundle.subprocess, "check_output", side_effect=[sha, ""]):
            package_bundle.package(self.root, artifacts, output, sha)
        result = bundle.verify_manifest(output)
        self.assertEqual(result["commit"], sha)
        self.assertEqual(set(result["images"]), set(bundle.IMAGE_ROLES))
        original_copy = package_bundle.shutil.copyfile
        def changed_during_copy(src, dst):
            result = original_copy(src, dst)
            if Path(dst).name == "gui-tools.oci":
                Path(dst).write_bytes(b"changed after initial checksum")
            return result
        interrupted = self.root / "changed-copy"
        with patch.object(package_bundle.subprocess, "check_output", side_effect=[sha, ""]), \
             patch.object(package_bundle.shutil, "copyfile", side_effect=changed_during_copy):
            with self.assertRaisesRegex(RuntimeError, "image-checksum-mismatch"):
                package_bundle.package(self.root, artifacts, interrupted, sha)
        self.assertFalse((interrupted / "SHA256SUMS").exists())
        (evidence / "gui-provider-receipt.json").write_text(json.dumps({"passed": True, "existingHomeRecovered": True, "imageDigest": "sha256:" + "c" * 64}))
        with patch.object(package_bundle.subprocess, "check_output", side_effect=[sha, ""]):
            with self.assertRaisesRegex(RuntimeError, "receipt-image-mismatch"):
                package_bundle.package(self.root, artifacts, self.root / "wrong-image", sha)
        self.assertFalse((self.root / "wrong-image").exists())
        run["head_sha"] = "c" * 40
        (artifacts / "workflow-run.json").write_text(json.dumps(run))
        with patch.object(package_bundle.subprocess, "check_output", side_effect=[sha, ""]):
            with self.assertRaisesRegex(RuntimeError, "ci-not-passed"):
                package_bundle.package(self.root, artifacts, self.root / "wrong", sha)
        self.assertFalse((self.root / "wrong").exists())


if __name__ == "__main__":
    unittest.main()
