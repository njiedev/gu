---
name: publish
description: Turn a command-line tool, script or small repo the user wrote into a tested tool Claude can call from any project, using gu. Use when the user asks to publish, install, wrap, expose or "make available to Claude/agents" a script or CLI of theirs, or says "use gu on" a folder.
---

# Publish a tool with gu

gu turns a folder with a command-line tool into MCP tools (named `<tool>__<command>` under the `gu` server) that Claude can use in every project. A short `gu.yaml` card in the tool's folder says how to call it and how to test it. gu installs a checked copy, sets up its Python or Node dependencies, and runs the test before the tool becomes visible.

Run gu as `npx -y @njiedev/gu@0.1.0` (or `gu` if it is on PATH). Below, `gu` means either.

## Steps

1. Go to the tool's folder (the repository root if it holds several tools) and run `gu publish`.
2. Act on the exit code:
   - **2: the card isn't written yet.** gu printed the card-writing rules. Follow them exactly: read the code, write `gu.yaml` in each tool folder, and create tiny test inputs under `.gu/test/`. Then run `gu publish --yes`.
   - **1: something failed.** Read gu's message. Fix the card or the test input (not the user's code, unless they ask) and run `gu publish --yes` again. If a tool needs a secret, tell the user to run `gu install <folder>` in their own terminal once, so gu can ask for it privately. Never ask them to paste a secret into the chat.
   - **0: installed.** Every tool passed its test.
3. Tell the user which tools were installed, in plain words, and what to ask for to use them. The tools appear in this session within a few seconds. If they don't, the user should start a new session.
4. Suggest committing `gu.yaml` and `.gu/test/` so another machine can run `gu install github.com/<owner>/<repo>`.

## Rules

- Only describe flags and behavior you saw in the code. Never invent options.
- Tools run in the user's current project folder, so write cards whose output lands there or whose `returns` says where it goes.
- Servers, GUIs and tools that only work interactively can't be published. Tell the user what's missing (a non-interactive command) instead of forcing a card.
