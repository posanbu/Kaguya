---
title: 功能介绍
---

# 功能介绍

MaiBot（麦麦）不仅仅是一个聊天机器人——她是一个致力于以真实人类风格进行交互的数字生命。以下是她拥有的核心能力。

<div class="feature-cards">

<div class="feature-card">

### 💬 智能对话管线

从消息接收到最终回复的完整处理管线，支持 Hook 拦截、命令分发、过滤检查和灵活路由。

[了解消息管线 →](../manual/features/message-pipeline.md)

</div>

<div class="feature-card">

### 🧠 Maisaka 推理引擎

基于工具调用的多轮内部推理系统。Planner 决策、工具调用、自动打断与重试，让对话节奏自然流畅。

[了解 Maisaka →](../manual/features/maisaka-reasoning.md)

</div>

<div class="feature-card">

### ❤️ 长期记忆系统

A-Memorix 记忆引擎提供知识图谱、对话摘要和人物画像，自动写回机制让麦麦持续积累对你的了解。

[了解记忆系统 →](../manual/features/memory-system.md)

</div>

<div class="feature-card">

### 📖 表达与黑话学习

自动从对话中提取表达风格和群体黑话，通过 LLM 推断含义并逐步完善，让麦麦越来越像你身边的人。

[了解学习系统 →](../manual/features/learning.md)

</div>

<div class="feature-card">

### 😊 表情包系统

基于 VLM 的表情包自动识别、情绪标签生成和智能选择，让对话更生动。

[了解表情系统 →](../manual/features/emoji-system.md)

</div>

<div class="feature-card">

### 🔌 MCP 集成

支持 Model Context Protocol，连接外部工具服务器，无限扩展麦麦的能力边界。

[了解 MCP →](../manual/features/mcp.md)

</div>

</div>

<style>
.feature-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 16px;
  margin-top: 24px;
}
.feature-card {
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  padding: 20px;
  transition: border-color 0.25s, box-shadow 0.25s;
}
.feature-card:hover {
  border-color: var(--vp-c-brand);
  box-shadow: 0 2px 12px var(--vp-c-brand-soft);
}
.feature-card h3 {
  margin-top: 0;
  font-size: 1.1em;
}
.feature-card a {
  font-size: 0.9em;
}
</style>
