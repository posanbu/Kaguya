---
title: Plugin Issues
---

# Plugin Issues

## Why does an enabled plugin not work?

Read the plugin's README and confirm required configuration, dependencies, permissions, and compatible MaiBot versions. Then inspect startup logs for load, validation, command-registration, or event-registration errors.

## Why is a plugin command treated as a normal chat message?

Verify the command syntax and prefix and confirm that the plugin registered its command. Duplicate commands or another plugin intercepting and modifying the event can allow the message to continue into normal chat handling.

Temporarily disable recently installed plugins and restore them one at a time to locate the conflict.

## How do I diagnose plugin conflicts?

Record the last installed or updated plugins and disable them in batches. Compare command names, hooks, event priority, and dependency versions after identifying the pair. Do not assume that an old online report applies to the current version.

## What should I do when a plugin download fails?

Check the repository URL, network, Git installation, proxy, and mirror settings. Confirm the repository's actual default branch; it may be `main`, `master`, or something else. If the repository is reachable, inspect the install log for Git, permission, and dependency errors.

## What if a plugin stops working after an update?

Read its release notes and migration instructions and verify the supported MaiBot versions. Back up the plugin directory and configuration before rolling back, then follow the repository's version guidance.

