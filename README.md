<div align="center">

  <h1>辉夜 Kaguya</h1>
  <p>以事件感知世界，以记忆形成自我。</p>
  <sub><sup>An event-driven AI companion, shaped by memory.</sup></sub>

  <p>
    <img src="https://img.shields.io/badge/Node.js-24.18.0-339933?logo=nodedotjs&logoColor=white" alt="Node.js 24.18.0">
    <img src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white" alt="TypeScript">
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue" alt="MIT License"></a>
    <img src="https://img.shields.io/badge/Status-In%20Development-yellow" alt="开发中">
    <a href="https://github.com/posanbu/Kaguya/stargazers"><img src="https://img.shields.io/github/stars/posanbu/Kaguya?style=flat&label=Stars" alt="GitHub Stars"></a>
  </p>

  <p>
    <a href="#design">💡 核心设计</a> &nbsp;|&nbsp;
    <a href="#quick-start">📦 快速开始</a> &nbsp;|&nbsp;
    <a href="https://posanbu.github.io/Kaguya/">📚 文档站</a> &nbsp;|&nbsp;
    <a href="#community">💬 交流反馈</a> &nbsp;|&nbsp;
    <a href="CONTRIBUTING.md">🤝 参与贡献</a>
  </p>

</div>

## 🌙 认识辉夜

<sub><sup>Meet Kaguya</sup></sub>

<img src="docs/public/kaguya-logo.png" align="right" width="26%" alt="Kaguya 金色月牙标志">

辉夜 Kaguya 是一个基于大语言模型的聊天智能体，希望成为亲切、自然的 AI 群友：一起闲聊、一起吐槽，在合适的时候接话，也为倾听和沉默留出空间。

辉夜持续感知所处的环境，把零碎信息放回正在发生的情境中理解，再决定是否、何时以及如何自然互动，并在共同经历中逐渐形成记忆与个性。

支撑这一目标的是一套 **event-driven（事件驱动）框架**。一个持续运行的 Agent 可以连接群聊、私聊、live、工具或设备等多个场景；新信息到达是重新观察环境的契机，而不是自动开始一轮问答。统一的信息底座保存可追溯的事实，各模块再按自己的职责选择完整上下文，而不是把收到的单条信息直接当成全部语境。

<br clear="both">

<a id="design"></a>

## 💡 为什么这样设计

<sub><sup>One Agent, Many Connections</sup></sub>

### 持续感知：新信息不是新的回合

群聊和 live 中的信息往往零碎、连续，也不一定是在向辉夜提问。聊天消息、定时事实、后台任务结果或设备反馈都可以成为一次唤醒：它们提醒系统“环境发生了变化”，但不自动创建一个必须完成的 turn，也不承诺生成回复或长期记忆。

多个唤醒可以被合并理解，一次行动也可以建立在多项变化之上。这里的“持续感知”不表示持续调用模型，而是让系统能够被相关信息唤醒，并从已经处理到的位置继续观察。

### 自然互动：行动不与消息一一对应

辉夜先理解正在发生的情境，再选择 `message`、`wait` 或 `silent`。群里正在补充问题时可以继续等待；没有新增交流价值时可以保持沉默；耗时工具完成后，也可以根据返回结果继续此前的事情。

因此，收到一条信息和采取一次行动是两件事。输入与输出可以按各自节奏推进，但“双轨”只是帮助设计模块边界的实现哲学，不是需要用户理解的产品概念，也不预设一种通用并发协议。

### 一个 Agent，连接多个场景

来自不同入口的信息汇入统一的信息底座，各模块订阅自己关心的事实，处理后再发布结果。持久化的信息原子保存证据与来源；它可以唤醒模块，却不自动等于模块需要理解的完整上下文。

这让**入口与能力可以分开演进**：增加一个聊天平台，可以复用已有的记忆与决策模块；增加一种能力，也能服务于多个入口。统一的是辉夜的身份、运行事实与能力，具体观察和行动仍按场景范围选择上下文，保留人物、群聊和权限边界，避免把不同场景的信息混用。

面向贡献者的术语、模块检查项和当前实现映射见[持续 Agent 设计原则](docs/developers/continuous-agent.md)与[运行时架构](docs/developers/architecture.md)。

### 插件与外设：为同一个智能体增加感知和行动

插件负责处理事件，适配器负责把外部输入转换成可理解的信息，并把动作交给对应的平台或设备。这样，聊天平台、工具和外设可以接入同一套处理过程，无须各自维护一份完整的聊天逻辑。

这为**跨平台复用与软硬件协作**提供了扩展方式：语音输入可以产生识别结果，传感器可以报告状态，设备动作可以返回完成或失败，再由后续模块决定如何回应。开发者可以专注于新能力的输入、输出和行为契约，复用已有的记忆、模型调用与运行观测机制。

当前已有 Web 与 NapCat 接入；上述语音和硬件场景说明扩展方向，具体设备仍需实现适配器，第三方插件也需对接 Kaguya 的接口。开发入口见[信息模块开发](docs/developers/information-modules.md)。

### Memory 塑造人设：让个性有来历，也能变化

我们的设计目标是**让所有人设都通过 Memory 表达和演化**：她如何认识自己、喜欢什么、与谁有怎样的关系，都能关联到背景经历与相处过程。原始信息可以逐条保存为证据，人物认识、关系、自我和表达习惯等派生结果则应根据职责读取完整情境或证据集合，而不是把触发模块的单条信息直接当成全部经历。生成回复时，再根据当前情境取用相关记忆，让个性落实到具体的选择和表达中。

这样的好处是，人设可以有连续性，也有调整的空间。同样的初始背景，在不同的相处经历下可以形成不同的偏好与关系；新的经历可以补充或修正旧认识；与当前话题无关的性格细节，也不必反复出现在每次回答里。我们希望由此减少僵硬的标签和口头禅，让行为更符合当下的关系与语境。

> [!NOTE]
> Memory 已支持历史消息写回、检索及可选认知能力，但当前仍保留固定的 `memory.identity.persona` 模板，Memory 默认关闭。“全部人设由 Memory 承载”是后续演进目标；人格自然度仍需实际交互验证。现有能力见 [Memory 文档](docs/developers/memory.md)。

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

<a id="community"></a>

## 💬 交流与贡献

<sub><sup>Community & Contributing</sup></sub>

欢迎分享你希望辉夜参与的聊天场景，也欢迎改进代码、文档和使用体验。

- **社区交流**：加入 [Discord 群组](https://discord.gg/PwvtanURJV)，交流使用体验、分享想法并讨论开发。
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
