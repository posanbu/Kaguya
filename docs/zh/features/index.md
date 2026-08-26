## 1 基础

llm sdk

我们要手动维护历史消息

### 事件循环

- 事件：会触发别的事件/动作
- 监听器：触发机制

事件队列

## 2 bot基本逻辑

### 监听器

- 事件：有消息更新
  （监听器（路由）：假如有消息更新）
  - 将新消息推入历史记录
  - 从历史记录中获取最新的n条对话
  - 获取（我们自定义的） memory/prompt
  - 将上面的信息组装成一次llm request的 prompt，（决定要不要回复），回复

- schedule/corn

### 长间隔（3h/每天）定时任务

目的：

- 在空闲时整理 memory
  - memory 可以是一组独立的事件组：memory的写的时机是可以自己设计的
  - 每天凌晨三点钟检查这一天的聊天记录，根据某个prompt（memory policy）获取特定信息存入数据库
  - memory policy 也可以是从某个数据库获取的
  - （xx事件（点）触发xx数据库更新（边））

我们要做的基础设施要提供点和边的定义方式，比较快速方便地构建复杂形态的 memory（workflow）

### 短间隔（1min/30s）心跳

- 假如设定的n很小，要有专门的短时状态更新
  - 评估bot的心情怎么样，得到的心情->被嵌入prompt
  - 用户关系
  - 短时记忆
- 路由
  - 路由1：**每次有消息更新**，跑一遍路由决定回不回复
  - 路由2：**隔一段时间**（获取目前的历史消息）跑一遍路由

## 3 分工

具体要做的

研究maibot的事件循环

#### 3.1

- prompt组装方式的来龙去脉
  - 找到所有的llm request怎么发出
  - 每个prompt可能由多个来源的数据库/prompt（文本）组装而成
  - 最终会得到一个消息流转的图
- 心跳机制/监听器
  - 每个特殊的事件会触发什么（有消息进入，心跳/定时任务）
- 事件的设计
  - 每个事件包含什么字段（信息）
  - 事件怎么触发
- 抄什么：研究 maibot 的上述逻辑
  - 尝试做一个maibot各组件的抽象层
  - 可用的memory库可能有很多，可以调查一下，选什么库不一定重要
  - 测试 prompt 工具 [promptfoo](https://github.com/promptfoo/promptfoo)

#### 3.2

- 社交平台适配器（网关）：bot - 适配层 - 协议 -（社交平台适配器）- 社交平台
  - QQ：适配器用napcat，Onebot v11协议
  - tg：没有适配器层，官方给api
  - 写适配层，把各社交平台的消息（包括终端/webui）统一成一种 schema（raw/source/时间）统一的消息更新事件
  - 抄 openclaw/或者别的
  - koishi.js 有一个协议 satori 兼容多平台的统一的事件字段协议，适配层可以抄他

#### 3.3

- webui/文档站ui
  - 调研现有框架 web框架/静态站点框架
  - 实在找不到去抄 moeru-ai/airi 文档站
  - 千万不要手写 html

- 评估/可视化
  - 先感受一下（手动评估）
  - memory 结构/更新可视化
  - prompt组装/场景/剧本/角色状态可视化
  - 要么找bench

#### 3.4

- computer use（cua）

qq插件生态兼容

AI bot

- 50% astrbot
- 30% 官方弱智bot
- 15% maibot

## 4 开发

使用 typescript

读不懂让ai解释

test-driven

- 看测试用例
- 回归测试：修bug的过程中，当你发现bug之后可以立即写一个测试（会不通过）
- 最好让 coding agent解释一下写了什么测试

docs

- 边写代码边写文档
- 写完之后自己看一遍，因为ai写的可能跟你关注点不一样
- manual（可以最后写） / contributing guide（开发时写） 分开

技术选型

## 5 计划

- [ ] 做一个init commit (3.1) - cnc/ldh/hjb
  - [ ] sdk / 数据库 / 子包的划分（研究maibot，自己归类） 定下来
  - [ ] 确保研究明白之后，直接 codex 每个子包写出来，跑通就交
  - [ ] markdown 文档
- [ ] ui - lfx/lzf/cly
- [ ] 适配器（相对独立且抄就行了）
