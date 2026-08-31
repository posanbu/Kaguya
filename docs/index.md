---
layout: home
title: Kaguya 文档
sidebar: false
outline: false

hero:
  name: Kaguya
  text: TypeScript AI Bot Runtime
  tagline: 一个长期运行进程、一条事件主链，以及可组合的模块与平台适配边界。
  image:
    src: /kaguya-logo.png
    alt: Kaguya 月牙与星形项目图标
  actions:
    - theme: brand
      text: 开始使用
      link: /guide/
    - theme: alt
      text: 理解架构
      link: /developers/architecture
    - theme: alt
      text: 查看 GitHub
      link: https://github.com/posanbu/Kaguya

features:
  - icon: ⚡
    title: 事件驱动
    details: 入站消息持久化后广播标准事件，由模块自行过滤、调用模型并请求出站投递。
  - icon: 🧩
    title: 模块可组合
    details: Runtime 只提供事件、LLM 与 transport 边界，不把固定回复流程写死在 Core 中。
  - icon: 🖥️
    title: 统一 Server
    details: Fastify 在同一进程、同一端口提供 Web UI、HTTP API 与可选 NapCat 连接。
  - icon: 🔎
    title: 全链路可审计
    details: SQLite、结构化日志和 traceId 共同记录消息、模型调用、事件因果与投递状态。
---
