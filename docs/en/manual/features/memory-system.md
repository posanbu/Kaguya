---
title: How MaiBot Remembers You
---

# How MaiBot Remembers You 🧠

Have you noticed that the more you chat with MaiBot, the better it understands you? It's not an illusion! MaiBot genuinely has "memory". When long-term memory is enabled, it saves important conversations, person facts, and chat summaries according to your configuration, making future replies better match your shared experiences.

## Just Like Human Memory

### 📝 What Does It Remember?

**Basic information about you**

- Your name, nickname
- What you like and dislike
- Your speaking style
- Which groups you are active in

**Your chat history**

- Important content you've discussed
- Questions you've asked
- Feedback you've given
- Fun things you've experienced together

**Your habits and preferences**

- Topics you enjoy
- When you're usually active
- Words you like to use
- What you're sensitive about

### 🎯 How Does It Remember?

**Automatic memory**
When the corresponding switches are enabled, MaiBot automatically:

- Extracts stable person facts after sending a reply
- Organizes chat summaries by message window
- Updates the "profile" of relevant people
- Writes important content into long-term memory

**Smart organization**
It doesn't remember everything indiscriminately; instead it:

- Filters for valuable information
- Merges similar content
- Periodically organizes and summarizes

**Continuous updates**
Your preferences change, and so does it:

- Old, inaccurate information gets updated
- New important information gets added
- Its understanding of you adjusts to new situations

::: tip
The memory system does not unconditionally remember every message. Whether querying, profile injection, person-fact write-back, chat-summary write-back, and feedback correction are allowed can all be configured in `[a_memorix.integration]`.
:::

## What Makes Up the Memory System?

A_Memorix is not a single "notebook" but a set of capabilities working together around long-term conversation experience. The modules below jointly decide what MaiBot can remember, how it organizes memories, and when it uses them.

### Long-term Memory Retrieval

Long-term memory retrieval is responsible for finding previously saved information when needed. MaiBot can look up relevant memories by current topic, person, time range, or episode, and then use the results as a reference when replying.

This type of memory suits relatively stable information, such as preferences, long-term facts, important conversations, and imported materials.

### Person Profiles

Person profiles maintain a summary archive for chat partners, recording relatively stable names, preferences, interaction traits, and recent important information. They are not chat logs themselves, but a "understanding of this person" distilled from multiple memories.

Profiles let MaiBot quickly grasp who the current partner is, what they prefer, and which information needs attention before replying.

### Episode Memory

Episodes organize a stretch of chat or a group of related content into experience fragments. Compared with single facts, they better express "what happened during a period" or "what we discussed together before".

Episode memory is especially helpful when users ask about a past experience, a past conversation, or something that happened around a certain time.

### Knowledge Graph

The knowledge graph represents entities and connections in memory as nodes and relations. Nodes can be people, topics, projects, or concepts; relations describe how they are linked.

Its purpose is not to replace chat summaries, but to help the system understand "who is related to what" and "which information connects to which", and to make it convenient to view and correct relations in the WebUI.

### Source Management

Source management records where memories came from — a chat stream, an import task, or a piece of material. It lets memories be traced, filtered, and batch-processed.

When a batch of material becomes outdated, or a chat source should no longer be kept, source information helps you manage memory more precisely.

### Automatic Write-back

Automatic write-back is responsible for sedimenting important chat information into long-term memory. It currently mainly covers person-fact write-back and chat-summary write-back: the former focuses on stable person information, the latter on the overall content of a conversation.

Whether automatic write-back is enabled, its frequency, and the context scope are all controlled by configuration.

### Import Center

The import center adds existing materials to long-term memory, such as pasted text, uploaded files, or migrated historical data. It lets MaiBot quickly acquire background knowledge rather than relying solely on slowly accumulating chat.

Imported content also flows into retrieval, the knowledge graph, episodes, and source management.

### Feedback Correction

Feedback correction handles cases where "old memories are proven inaccurate by later feedback". When enabled, after MaiBot queries memories, the system can combine subsequent user feedback to decide whether to mark or correct old content.

This is an advanced capability suited to scenarios with large memory volumes where you want to reduce interference from outdated memories.

### Memory Maintenance

Memory maintenance adjusts the importance and retention tendency of memories. Some memories can be reinforced, some relations weakened, particularly important content can be kept longer, and unneeded content can be forgotten.

These capabilities let memory not just "store" but also gradually adjust weights through use.

### Delete and Restore

Delete and restore provide a more cautious cleanup process. Before deletion you can preview the impact scope, and after deletion some content can be recovered via a recycle bin or operation logs.

It suits handling mistakenly imported, outdated, private, or otherwise unwanted memories that should not keep participating in retrieval.

### Retrieval Tuning

Retrieval tuning improves problems like "searching too little, too noisy, or not relevant enough". It adjusts long-term memory search quality around recall count, ranking strategy, thresholds, and retrieval profiles.

Tuning does not change MaiBot's personality; it affects how it finds material from the memory store.

### Runtime Self-check

Runtime self-check verifies whether the memory system currently works properly, especially baseline state such as embedding, vector dimensions, the vector store, and auto-save.

When memory is enabled but nothing is retrieved, or imports fail, or vectorization errors occur, these checks help locate the problem.

## Building a "Profile" for Everyone 👤

### What Is a Person Profile?

Just as real people "tag" others, MaiBot builds a "profile" for everyone:

```
User: XiaoMing
├─ Basic info
│  ├─ Nicknames: Mingming, Brother Ming
│  ├─ Active hours: 8-11 pm
│  └─ Active groups: gaming group, classmates group
├─ Personality traits
│  ├─ Speaking style: humorous, loves jokes
│  ├─ Interests: gaming, anime, tech
│  └─ Reaction style: optimistic and positive
├─ Chat preferences
│  ├─ Likes: game guides, new tech
│  ├─ Dislikes: overly serious topics
│  └─ Common expressions: "haha", "awesome", "okay"
└─ Important memories
   ├─ I helped him solve a game problem last time
   ├─ He doesn't like being called bad at games
   └─ He's recently learning to code
```

### What Is the Profile Used For?

**Replies that understand you better**

- Knows your preferred style and replies in that style
- Understands your knowledge level and explains in terms you can follow
- Remembers your preferences and gives suggestions that suit you better

**More natural conversations**

- Doesn't repeat things you've already said
- Picks up topics you've discussed before
- Speaks more and more like your friend

**More considerate service**

- Knows what help you need
- Proactively provides information when you need it
- Communicates in the way most comfortable for you

## Types of Memory

### 🧠 Long-term Memory

Like human long-term memory, it remembers:

- Your basic characteristics (relatively stable)
- Your important conversations
- Your core preferences

These memories last a long time and survive restarts. Memory data is stored in the `data/a-memorix` directory by default.

### 💭 Short-term Memory

Like human working memory, it keeps:

- The context of the current conversation
- What was just discussed
- Temporarily important information

These memories help it keep up with the rhythm of the current conversation.

### 📊 Conversation Summary

Periodically summarizes your chats:

- What was discussed in this period
- Whether anything important happened
- How your state changed

## How Does Memory Work?

### 1️⃣ Collecting Information

During each chat:

- Listens to what you say
- Observes your reactions
- Records important details

### 2️⃣ Extracting Key Points

When write-back conditions are met:

- Extracts key information
- Identifies important changes
- Updates related memories

### 3️⃣ Organizing and Storing

Periodic organization:

- Merges similar information
- Deletes outdated content
- Reinforces important memories

### 4️⃣ Retrieving and Using

When needed:

- Quickly finds relevant memories
- Uses them in the current context
- Gives personalized replies

## Privacy and Security 🔒

### Your Data Is Safe

- Memory data is stored in the local data directory by default
- The WebUI can view and manage long-term memory
- Summaries, profiles, correction, and vectorization may call the model services you configured

### You Have Control

- You can view what it has remembered
- You can delete content you don't want it to keep
- You can adjust retention policies through memory evolution, reinforcement, freezing, and protection

### Transparency

- You can view long-term memories, person profiles, and sources through the WebUI
- You can disable memory querying, profile injection, or automatic write-back
- You can view and manage everything at any time

## The Effects of Memory

### 🌟 Understanding You Better Over Time

Early on: "Hi, I'm MaiBot"
After a while: "Hey, free to chat today? How's the gaming going?"

### 🎯 Getting More Attentive

Early on: gives generic advice
After a while: "Based on what you said last time, I think this suits you better"

### 🤝 Becoming More Natural

Early on: like a customer-service bot
After a while: like a real friend

## Want to View or Manage Memories?

Through the WebUI you can:

- See what it has remembered about you
- Correct inaccurate person profiles or graph relations
- Delete content you don't want to keep
- Import materials, handle the recycle bin, and tune retrieval

[Go to the WebUI memory management page →](../webui/memory-management.md)

---

MaiBot's memory system lets it do more than "remember" you — it gradually forms a more stable understanding through long-term conversation. It will understand you better and better, becoming more like a true friend. But remember: you can always manage which memories it can read and write through configuration and the WebUI.
