# W7 + W8 Linux 一次性安装包

本包对应 `manifest.json` 中的 Git SHA 和成功 CI run，包含完整宿主 broker、shell 监督程序、固定依赖清单、两份 Chromium seccomp 配置，以及 shell、Chromium、GUI 三份 OCI 镜像。`SHA256SUMS` 校验整个包；`verify` 会再次核对固定 commit、按角色固定的镜像摘要引用，以及包内 workflow 和 GUI 回执。离线校验只证明包内信息一致；部署前还须独立核对该 SHA 的真实 CI 状态、产物来源和交接消息中的 manifest SHA-256。实际执行入口为 `install_bundle.py`，特权系统变更全部复用包内的 `bootstrap.py`。

在 **Ubuntu 26.04 x86_64 本机终端**以 `andrew` 登录，将整个包放到新目录。旧 `9fd7bae` 安装包已废弃，不得执行；保留旧 staging 供核对，不覆盖已有安装包。先审阅 `HOST-DETAILS.md`、`TOOLS-DETAILS.md`、代码和依赖清单；父会话的独立安装审查通过后执行：

```bash
sha256sum -c SHA256SUMS
python3 -I install_bundle.py verify --trusted-user andrew
python3 -I install_bundle.py install --trusted-user andrew
```

最后一条命令先做只读预检，再通过 sudo 运行一次管理员 bootstrap；其后以原用户导入三份镜像并保存 `installation-receipt-*.json`。安装入口不以 root 身份运行。bootstrap 需要专用存储容量，首次实际分配 24 GiB 与 4 GiB 的 ext4 镜像；镜像导入还占用 inbox、私有校验副本及镜像存储空间。源文件和归档均先校验，失败时停止并保留可检查状态。不要在未知旧 job 尚未排空时升级；先停止新任务提交并核对旧 job 状态。

安装只建立 Linux 工具基础设施并导入镜像；Kaguya、PostgreSQL、QQ/NapCat、Profile 与会话数据保持现有状态。后续由宿主使用 manifest 中的完整 `name@sha256:...` 创建环境，再在 `linux-tools.json` 中显式配置实际 scope/environment/workflow。GUI 环境使用 `desktopKind: "gui"` 和 `sandboxPolicy: "chromium-v1"`；`guiModel` 只用于独立 `agent.gui.execute`。没有 scope 或模型配置时不自动猜测或启用。详见 `TOOLS-DETAILS.md`。

本包应配套同一 SHA 的 CI 证据，覆盖实际 rootless shell、Chromium sandbox、跨 UID GUI、GTK 原图与人工接管；以独立核实的 CI 记录为准。生产 Ubuntu 的系统安装、网络边界、容量和实际桌面启动须在安装后按 `HOST-DETAILS.md` 现场验收。真实模型管理 API→GUI 闭环由 W11 统一联调；本包不发送任何模型请求。

## 回退

仍在原目录，以同一受信用户运行：

```bash
python3 -I install_bundle.py rollback --trusted-user andrew
```

回退先关闭工具 admission 并停止专属 job/container，再停用 broker、专用用户服务和网络单元。账户、subuid/subgid、代码、存储镜像、journal、workspace/private 卷、图片及其他产物保留。回退不要求安装时的空闲空间，也不删除数据库或 QQ 会话。隔离未确认时停止并保留网络边界。最终卸载和数据清理需要单独安排。

`verify` 不修改系统。`install` 可复用已经成功的 bootstrap 状态和相同 hash 的 inbox 文件；若中断留下不完整 inbox 文件，入口会拒绝它，先核对该文件再决定清理，不能将失败副本当作已导入。安装回执证明实际成功的步骤；仅有包或 CI 结果不表示本机已安装。
