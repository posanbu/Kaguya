---
layout: home
title: Kaguya 文档
sidebar: false
outline: false

hero:
  name: Kaguya
  text: TypeScript AI Bot Runtime
  tagline: 一个长期运行进程、一张持久化信息 DAG，以及可组合的模块与平台适配边界。
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
    title: 持久化信息 DAG
    details: 入站内容先提交 PostgreSQL 信息账本，再按 Kind 广播；模块显式注册过滤、模型与投递的下一事实。
  - icon: 🧩
    title: 模块可组合
    details: Runtime 只提供 Information Kind、LLM 与 transport 边界，不把固定回复流程写死在 Core 中。
  - icon: 🖥️
    title: 统一 Server
    details: Fastify 在同一进程、同一端口提供 Web UI、HTTP API 与可选 NapCat 连接。
  - icon: 🔎
    title: 全链路可审计
    details: PostgreSQL 账本以 informationId 与显式引用记录消息、模型调用、失败与投递状态。
---
