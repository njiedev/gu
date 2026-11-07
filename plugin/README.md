# gu for Claude Code

Turn the scripts and command-line tools you write for yourself into tested tools Claude can find and use in every project.

## Install

```
/plugin install gu --marketplace njiedev/gu
```

On Claude Code older than 2.1.275, run `/plugin marketplace add njiedev/gu` and then `/plugin install gu@gu`. Needs Node 20 or newer.

## Use

Tell Claude what you want:

- "Publish ~/code/color-matcher with gu." Claude reads the code, writes a short `gu.yaml` card, and gu installs a copy and runs its test. The tool shows up in Claude right away, in every project.
- "Make beach.png match the colors of sunset.png." Claude picks your tool and runs it.
- "Which gu tools do I have?", "Update color-matcher", "Uninstall color-matcher".
- "Install the tools from github.com/someone/their-tools." Claude shows you every command that would run, and only installs once you agree.

## What's inside

- **The gu MCP server**, run with `npx @njiedev/gu`. Your tools run on your machine; nothing is uploaded.
- **publish skill**: how to turn a folder into a tested tool.
- **manage skill**: status, updates, uninstalling, and safe installs from GitHub.

gu also works with Codex and other MCP clients: see the [main README](https://github.com/njiedev/gu#readme).

## Safety

gu is not a sandbox. Installed tools run with your permissions. Only install tools from repositories you trust.
