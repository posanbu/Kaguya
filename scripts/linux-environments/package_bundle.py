#!/usr/bin/env python3
"""功能概述：将固定 Git SHA 的 W6 宿主文件和同 SHA 已通过 CI 的 W7/W8 OCI 合成离线安装目录。
主要职责：核验 workflow run、三个归档 hash 和 GUI provider 回执，复制源码及镜像后重新验证最终包，再生成 SHA256SUMS。
离线检查只证明包内证据一致性，实际 CI 状态须由调用者从可信来源独立核对。
代码库关系：与 install_bundle.py 配套；只读 Git/CI 下载目录，不触碰旧 staging，不执行安装或 broker RPC。
输入输出与副作用：artifacts 采用 gh run download 的原始命名目录；输出目录必须不存在，失败不覆盖旧包。
"""
import argparse
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from install_bundle import SOURCE_FILES, IMAGE_ROLES, digest, regular, verify_ci_evidence, verify_manifest  # noqa: E402


def package(root, artifacts, output, sha):
    actual = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
    if not re.fullmatch(r"[a-f0-9]{40}", sha) or actual != sha:
        raise RuntimeError("bundle-checkout-sha-mismatch")
    if subprocess.check_output(["git", "-C", str(root), "status", "--porcelain", "--", "scripts/linux-environments", "scripts/linux-tools"], text=True).strip():
        raise RuntimeError("bundle-source-not-committed")
    run = json.loads((artifacts / "workflow-run.json").read_text())
    if run.get("head_sha") != sha or run.get("conclusion") != "success" or run.get("status") != "completed":
        raise RuntimeError("bundle-ci-not-passed")
    evidence = artifacts / ("gui-evidence-" + sha) / "gui-provider-receipt.json"
    receipt = json.loads(evidence.read_text())
    if receipt.get("passed") is not True or receipt.get("existingHomeRecovered") is not True:
        raise RuntimeError("bundle-gui-provider-not-passed")
    images = {}
    for role in IMAGE_ROLES:
        directory = artifacts / (role + "-tools-" + sha)
        archive = directory / (role + "-tools.oci")
        regular(archive)
        checksum = (directory / (role + "-tools.oci.sha256")).read_text().split()[0]
        image_digest = (directory / (role + "-image.digest")).read_text().strip()
        if not re.fullmatch(r"[a-f0-9]{64}", checksum) or digest(archive) != checksum or not re.fullmatch(r"sha256:[a-f0-9]{64}", image_digest):
            raise RuntimeError("bundle-archive-identity-invalid")
        images[role] = {"file": archive.name, "archiveSha256": checksum,
                        "image": "localhost/kaguya-" + role + "@" + image_digest}
    verify_ci_evidence(run, receipt, sha, images)
    output.mkdir(parents=False, exist_ok=False)
    manifest = {"version": 1, "commit": sha, "workflowRun": run["html_url"], "sources": {}, "images": images}
    source = root / "scripts/linux-environments"
    for name in SOURCE_FILES:
        shutil.copyfile(source / name, output / name)
        manifest["sources"][name] = digest(output / name)
    for role, image in images.items():
        shutil.copyfile(artifacts / (role + "-tools-" + sha) / image["file"], output / image["file"])
    shutil.copyfile(source / "BUNDLE.md", output / "README.md")
    shutil.copyfile(source / "README.md", output / "HOST-DETAILS.md")
    shutil.copyfile(root / "scripts/linux-tools/README.md", output / "TOOLS-DETAILS.md")
    shutil.copyfile(evidence, output / "gui-provider-receipt.json")
    shutil.copyfile(artifacts / "workflow-run.json", output / "workflow-run.json")
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    # 对实际复制结果再检查，避免源归档在初次校验后变化仍发布成功回执。
    verify_manifest(output)
    checksums = []
    for path in sorted(output.iterdir()):
        checksums.append(digest(path) + "  " + path.name)
    (output / "SHA256SUMS").write_text("\n".join(checksums) + "\n")
    print(json.dumps({"path": str(output), "commit": sha, "manifestSha256": digest(output / "manifest.json")}, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifacts", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--commit", required=True)
    args = parser.parse_args()
    package(Path(__file__).resolve().parents[2], args.artifacts.resolve(), args.output.resolve(), args.commit)
