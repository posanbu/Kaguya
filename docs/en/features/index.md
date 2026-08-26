---
title: '# Feature Introduction'
---
# Feature Overview

MaiBot (MaiMai) is not just a chatbot — she is a digital life dedicated to interacting in a genuine human style. Below are her core capabilities.

<div class="feature-cards">

<div class="feature-card">

### 💬 Intelligent Conversation Pipeline

The complete processing pipeline from message reception to final response, supporting Hook interception, command dispatch, filtering checks, and flexible routing.

[Learn about the Message Pipeline →](../manual/features/message-pipeline.md)

</div>

<div class="feature-card">

### 🧠 Maisaka Reasoning Engine

A multi-turn internal reasoning system based on tool calling. Planner decisions, tool execution, automatic interruption, and retries keep conversation flow natural.

[Learn about Maisaka →](../manual/features/maisaka-reasoning.md)

</div>

<div class="feature-card">

### ❤️ Long-Term Memory System

The A-Memorix memory engine provides knowledge graphs, conversation summaries, and persona profiles. An automatic write-back mechanism enables MaiMai to continuously accumulate understanding of you.

[Learn about the Memory System →](../manual/features/memory-system.md)

</div>

<div class="feature-card">

### 📖 Expression and Slang Learning

Automatically extracts expression styles and group slang from conversations, infers meanings through LLMs, and gradually refines them, making MaiMai increasingly resemble the people around you.

[Learn about the Learning System →](../manual/features/learning.md)

</div>

<div class="feature-card">

### 😊 Sticker System

VLM-based automatic sticker recognition, emotion tag generation, and intelligent selection make conversations more vivid.

[Learn about the Sticker System →](../manual/features/emoji-system.md)

</div>

<div class="feature-card">

### 🔌 MCP Integration

Supports Model Context Protocol, connecting to external tool servers to infinitely expand MaiMai's capability boundaries.

[Learn about MCP →](../manual/features/mcp.md)

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
