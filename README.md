<div align="center">

  <h1>辉夜 Kaguya</h1>
  <p>一起闲聊，一起吐槽，一起生活在群聊之中。</p>
  <sub><sup>An AI companion for everyday conversations.</sup></sub>

  <p>
    <img src="https://img.shields.io/badge/Node.js-24.18.0-339933?logo=nodedotjs&logoColor=white" alt="Node.js 24.18.0">
    <img src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white" alt="TypeScript">
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue" alt="MIT License"></a>
    <img src="https://img.shields.io/badge/Status-In%20Development-yellow" alt="开发中">
    <a href="https://github.com/posanbu/Kaguya/stargazers"><img src="https://img.shields.io/github/stars/posanbu/Kaguya?style=flat&label=Stars" alt="GitHub Stars"></a>
  </p>

  <p>
    <a href="#quick-start">📦 快速开始</a> &nbsp;|&nbsp;
    <a href="https://posanbu.github.io/Kaguya/">📚 文档站</a> &nbsp;|&nbsp;
    <a href="#community">💬 交流反馈</a> &nbsp;|&nbsp;
    <a href="CONTRIBUTING.md">🤝 参与贡献</a>
  </p>

</div>

<br>

<img src="docs/public/kaguya-logo.png" align="right" width="26%" alt="Kaguya 金色月牙标志">

## 🌙 认识辉夜

<sub><sup>Meet Kaguya</sup></sub>

辉夜 Kaguya 是一个基于大语言模型的聊天智能体，希望成为群聊中亲切、自然的一位 AI 群友。她会关注大家正在聊什么，在合适的时候接话，也为倾听和沉默留出空间。

我们希望她能在日常相处中逐渐熟悉一个群的语境：从一句随口的分享，到一段热闹的讨论，让每次参与都更贴近当下的聊天。

- 💭 **自然地接上话题**：结合聊天上下文与角色设定组织表达，让回答的语气、长短和内容服务于这段对话。
- 🎭 **为发言把握时机**：先观察，再决定发言、等待更多上下文或保持沉默；是否开口与具体说什么分别处理。
- 🧠 **让相处留下记忆**：启用 Memory 后，可以保存和召回历史消息，为后续聊天提供有来源的记忆。Memory 默认关闭，可按需配置。
- 🌱 **学习群聊的表达习惯**：从真实聊天中归纳短句、反问等表达方式，在适合的场景中参考，让语言更贴近群里的节奏。
- 🧩 **培养你自己的辉夜**：通过角色设定、Prompt 模板和模块接口，调整她的表达与行为，或接入自己的能力。

<br clear="both">

## ✨ 与辉夜相处

<sub><sup>Chat, Configure & Explore</sup></sub>

你可以先在浏览器里与辉夜私聊，再通过 NapCat 接入 QQ 群聊或私聊。Web UI 同时提供模型配置、模块管理和运行检查入口，方便在使用中逐步调整她。

| 你想做什么               | 从这里开始                                                                     |
| :----------------------- | :----------------------------------------------------------------------------- |
| 在浏览器里聊几句         | [使用 Web UI](docs/guide/webui.md)：发送消息、查看回复与聊天历史               |
| 让辉夜加入 QQ 聊天       | [配置 Kaguya](docs/guide/configuration.md)：设置 NapCat 连接与入站、出站白名单 |
| 调整角色、模型与发言风格 | [配置指南](docs/guide/configuration.md)：身份设定、模型选择与本地 Prompt 覆盖  |
| 让历史聊天成为记忆       | [Memory 认知层](docs/developers/memory.md)：启用记忆、配置检索与可选认知能力   |
| 理解一次回复如何产生     | [运行观测](docs/developers/observability.md)：沿信息来源查看处理过程与结果     |

<a id="quick-start"></a>

## 📦 快速开始

<sub><sup>Quick Start</sup></sub>

项目正在开发中，以下是从源码启动的最短路径。升级已有实例前，请先阅读[安装与启动](docs/guide/installation.md)和[配置指南](docs/guide/configuration.md)，核对当前配置要求。

### 准备环境

- **Node.js 24.18.0** 与 **pnpm 11.9.0**，版本与仓库保持一致。
- 已启动的 **Docker Desktop、OrbStack 或其他兼容 Docker CLI 的引擎**，用于本地 PostgreSQL 17。
- 一个 **OpenAI-compatible 模型服务**的地址、API Key 与模型名称，用于首次配置。

工具链安装方式见[安装教程](docs/guide/installation.md)。准备完成后运行：

```bash
git clone https://github.com/posanbu/Kaguya.git
cd Kaguya
pnpm install
pnpm dev
```

开发命令会创建或复用本地 PostgreSQL 实例，并启动同一端口上的 Server 与 Web UI。

### 完成首次配置

1. 打开终端打印的完整 **`Kaguya access URL`**，进入 Web UI。
2. 按页面引导填写模型服务地址、API Key、Light Model 和 Heavy Model，保存后按提示重启服务。
3. 使用本次启动的新链接进入“消息”页，即可尝试私聊。接入 QQ 时，还需单独准备 NapCat，并配置连接和消息白名单。

> [!IMPORTANT]
> 完整访问链接包含本次启动的管理凭据，请勿分享。每次重启后需使用新链接；只打开根地址无法取得访问权限。

长期运行与外部数据库配置见[生产模式说明](docs/guide/installation.md)。遇到启动、模型或平台连接问题，可先查阅[故障排查](docs/guide/troubleshooting.md)。

## 💡 设计理念

<sub><sup>Design Philosophy</sup></sub>

**聊天需要表达，也需要倾听。** 群聊的话题会流动，一条消息可能仍在等待回应，也可能已经被后续讨论接住。辉夜把观察、发言决策和正文生成分开，让“现在是否适合说话”成为明确的一步。

**个性来自持续的设定与相处。** 角色设定决定她如何表达，记忆提供过去的语境，表达习惯帮助她适应聊天场景。这些能力各自承担清晰的职责，也保留独立调整的入口。

**每次行为都应有迹可循。** Kaguya 将消息、决策、模型调用与投递结果记录为持久化的信息原子，并用显式引用连接成信息 DAG。开发者可以沿来源检查一次行为，为扩展模块和定位问题提供依据。具体结构见[架构文档](docs/developers/architecture.md)。

<a id="community"></a>

## 💬 交流与贡献

<sub><sup>Community & Contributing</sup></sub>

欢迎分享你希望辉夜参与的聊天场景，也欢迎改进代码、文档和使用体验。

- **问题与建议**：前往 [GitHub Issues](https://github.com/posanbu/Kaguya/issues)，描述预期行为、实际表现和复现步骤。
- **参与开发**：先阅读[贡献指南](CONTRIBUTING.md)，了解环境准备、模块边界和验证要求。
- **编写模块**：从[信息模块开发](docs/developers/information-modules.md)开始，了解如何订阅信息、产生结果并接入运行时。
- **查阅文档**：访问 [Kaguya 文档站](https://posanbu.github.io/Kaguya/)，或直接阅读仓库中的[文档索引](docs/README.md)。

提交问题时，请隐去 API Key、管理访问链接和私人聊天内容。

## 🤝 致谢

<sub><sup>Acknowledgments</sup></sub>

感谢 [MaiBot](https://github.com/Mai-with-u/MaiBot) 对自然群聊交互的探索，本 README 的内容组织与排版也参考了该项目。感谢 [NapCat](https://github.com/NapNeko/NapCatQQ) 提供 QQ 平台接入能力，以及所有参与反馈、文档和代码贡献的朋友。

## 📄 开源协议

<sub><sup>License</sup></sub>

Kaguya 使用 [MIT License](LICENSE)。
