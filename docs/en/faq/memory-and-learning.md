---
title: Memory and Learning
---

# Memory and Learning

## How do I enable long-term memory?

Enable A_Memorix in the WebUI and configure a working embedding model. In configuration, the master switch is `enabled` under `[a_memorix.plugin]`. See [A_Memorix Configuration](../manual/configuration/amemorix-config.md).

## Why does the WebUI say relation vectors are disabled?

Normal memory vectors and relation vectors are separate features. Relation vectors are supported but disabled by default; this message does not mean all long-term memory is broken.

The enable, backfill, and import-write behavior is controlled under `a_memorix.retrieval.relation_vectorization`. Historical backfill can generate additional embedding requests.

## Why are there embedding requests when relation vectors are disabled?

Embeddings are also used for paragraphs, entities, and long-term memory retrieval. Disabling relation vectors only stops vector behavior for relation records, not the entire memory vector system.

## Can I leave the embedding model unconfigured?

Features that depend on vector retrieval, including long-term memory and knowledge import, require an embedding model. It can be omitted only when those features are not used; otherwise calls will be skipped or fail.

## Why does a memory reverse people or subject and object?

Inspect the source message for ambiguity, then review extraction and write-back logs. If the source is clear but extraction is wrong, test another memory-task model and correct or remove the stored item in the WebUI. A single failure is not enough to declare a specific model permanently unusable.

## How many examples are required to learn jargon?

There is no guaranteed fixed count. Sample consistency, context, and the learning model all affect the result. More consistent examples improve reliability, but learned meanings should still be reviewed and corrected in the WebUI when necessary.

## How can several chats share expressions or jargon?

Place the desired chat streams in the same expression or jargon sharing group. See [Bot Configuration](../manual/configuration/bot-config.md) for wildcard rules. Use global wildcards only when every chat should share learning results.

