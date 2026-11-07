# 功能概述：shell 工作容器与可信桌面入口共用固定镜像；控制状态和 shell supervisor 仅在宿主。
# W6 以 UID/GID 1000、只读 rootfs、独立 HOME 和持久 /workspace 启动固定 init。
FROM node:24.18.0-bookworm-slim@sha256:d45d78e7929b46875bbd4e29bea672d5bc48186c6c3588306521c815e78352d6
RUN apt-get update && apt-get install -y --no-install-recommends python3=3.11.2-1+b1 && rm -rf /var/lib/apt/lists/*
COPY --chown=0:0 scripts/linux-tools/ /opt/kaguya-tools/
RUN chmod 0555 /opt/kaguya-tools/init /opt/kaguya-tools/helper && mkdir -p /workspace /home/tool /private && chown 1000:1000 /workspace /home/tool /private
USER 1000:1000
ENV HOME=/home/tool
WORKDIR /workspace
ENTRYPOINT ["/opt/kaguya-tools/init"]
