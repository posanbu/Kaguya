---
title: View and Manage Memories
---
# View and Manage Memories

MaiBot remembers chat content, just like human memory. You can view and manage these memories in the WebUI.

## What are Memories?

Imagine MaiBot has a "brain" that records:

- 💬 **What was discussed** - Conversation content, important information
- 👥 **Who is known** - User personalities, preferences
- 🔗 **Knowledge Graph** - Relationships between entities
- 📚 **Learning Materials** - Knowledge you have taught it

## View Memories

### Memory Overview
Open the "Memory Management" page to see:
- Total number of items remembered
- Recently remembered content
- Memory category statistics

### Search Memories
Looking for specific content? Use the search function:
- Enter keywords, such as "games", "food"
- Filter by time to view memories from a specific period
- Filter by user to view chat memories with specific individuals

### Knowledge Graph
Like a mind map, displaying relationships between concepts:
- Each circle represents a concept (e.g., "Genshin Impact")
- Lines indicate relationships (e.g., "Genshin Impact - Game")
- Click a circle to view detailed information

## Manage Memories

### Add Memories
You can manually teach MaiBot new knowledge:
1. Click "Import Memory"
2. Paste text or upload a file
3. Select the processing method
4. Start the import

### Correct Memories
When you find profiles or relationships inaccurate, you can correct them through the corresponding management entry points:
1. Set or delete manual overrides in the user profile
2. Adjust nodes, relationships, or weights in the knowledge graph
3. Use feedback correction, restore from deletion, or re-import to handle outdated content

Plain paragraph text currently does not provide an arbitrary text editing entry point; when correction is needed, it is recommended to delete the erroneous source and re-import, or handle it through the feedback correction mechanism.

### Delete Memories
Do you want to forget certain content?
- Single deletion: Find the memory and click "Delete"
- Batch deletion: Select multiple items and delete them together
- Delete by source: Delete all memories from a specific group chat

⚠️ **Note**: Deleted items move to the recycle bin and can be restored

## User Profiles

MaiBot creates a "profile" for each user:
- Personality traits (outgoing, introverted, etc.)
- Interests and hobbies (games, anime, etc.)
- Chat habits (loves using emojis, speaking style, etc.)

You can:
- View your own profile
- Modify inaccurate descriptions
- Add notes for friends

## Advanced Features

### Memory Reinforcement
Make certain memories more important:
- Select important memories
- Click "Reinforce Memory"
- These memories will be less likely to be forgotten

### Permanent Memory
Especially important content can be set as permanent:
- Select "Permanent Memory"
- This content will never be automatically cleaned

### Memory Tuning
If MaiBot's memory performance is poor, you can:
- Adjust memory parameters
- Re-process memories
- Optimize retrieval effects

### Runtime Maintenance
The WebUI also provides operational entry points for runtime self-check, auto-save toggle, vector reconstruction, paragraph vector backfill, import task logs, and deletion operation records.

## Usage Recommendations

### Daily Maintenance
- Regularly check memories and delete useless content
- Correct errors promptly
- Manually reinforce important information

### Improve Performance
- Teach the bot professional knowledge to make it smarter
- Complete user profiles to make conversations more considerate
- Set memory capacity reasonably to balance performance and effects

## Frequently Asked Questions

**Q: How long are memories saved?**
A: Saved by default for the long term. Memory evolution will gradually decay the weights of old relationships; low-weight content may be marked for pruning. Specific behavior is controlled by the A_Memorix memory evolution configuration.

**Q: Do memories take up space?**
A: Text memories occupy very little space, feel free to use them.

**Q: Can memories be exported?**
A: Currently, only memory tuning configurations can be exported; full memory export is not yet supported.

**Q: Will memories leak privacy?**
A: Memory data is stored by default in the local directory. Generating summaries, profiles, corrections, or vectors may call your configured model services. Please confirm data boundaries based on your deployment method and model provider.