---
title: Models and APIs
---

# Models and APIs

## What should I do about API key or balance errors?

For `401`, `402`, or `403` responses, verify that the key is complete and belongs to the selected provider, the account has balance, the key is active, and `base_url` and authentication settings are correct. Never expose the full key in shared logs.

## What if the model is missing from the dropdown?

Enter the provider's model identifier manually. The display name can be customized, but `model_identifier` must exactly match the provider API, including case and version suffixes. If the API returns `model not found`, verify account access in the provider console.

## How do I configure a vision model?

The model must support image input and be marked as visual in the MaiBot model list. A name containing `vision` or `vl` does not by itself prove API compatibility; check provider documentation and an actual request.

## What temperature should I use?

Lower values are generally more stable and higher values more varied, but support differs between models and reasoning modes. Some models ignore temperature or use other sampling parameters. Start with the provider's recommended value and adjust gradually.

## What should I check when embedding requests fail?

1. Confirm that the selected model is an embedding model.
2. Verify its identifier, API key, and `base_url`.
3. Standard OpenAI-compatible services usually expose `/v1/embeddings`.
4. Keep input within the model limit.
5. Ensure returned dimensions match the existing vector store.
6. Check network, proxy, and regional restrictions.

Changing to a model with different dimensions may require rebuilding vectors through the memory maintenance tools.

## Can I use multimodal embeddings?

Support depends on both MaiBot's current memory implementation and the service API. For text memory, prefer a stable text embedding model rather than assuming that any provider-labeled multimodal model is a drop-in replacement.

::: info Source note
Some embedding compatibility and multimodal-embedding troubleshooting ideas were adapted from the community [Quick FAQ / Community Tutorial](https://www.kdocs.cn/l/ctOGhVv6L8Yq), where the relevant notes are explicitly credited to ARC. This page corrects the endpoint and scope for the current implementation.
:::
