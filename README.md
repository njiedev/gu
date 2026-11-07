<p align="center">
  <img src="site/assets/readme-banner.gif" alt="gu: your tools, ready for your agent" width="100%">
</p>

gu turns the little command-line tools you build for yourself into tools your AI agent can find and use. A short `gu.yaml` card says how to call the tool and how to test it. gu installs a checked copy, runs its test, and connects itself to Claude Code and Codex over MCP. From then on your agent can use the tool from any project.

Everything runs on your machine, on macOS and Linux. Nothing is uploaded to a registry.

## Install

**In Claude Code**, install the plugin:

```
/plugin install gu --marketplace njiedev/gu
```

On Claude Code versions older than 2.1.275, run `/plugin marketplace add njiedev/gu` and then `/plugin install gu@gu`. The plugin starts gu's MCP server and teaches Claude when and how to publish your tools, so you can just say "publish ~/code/my-tool". It needs Node 20 or newer.

**Anywhere else** (Codex, other MCP clients, or your own terminal):

```sh
npm install -g @njiedev/gu     # needs Node 20 or newer
```

Or build a single binary from source with [Bun](https://bun.sh):

```sh
git clone https://github.com/njiedev/gu && cd gu && bun install && bun run build
# then move dist/gu somewhere on your PATH and keep it there
```

You'll also need:

- **Claude Code and/or Codex.** gu connects to whichever is installed. Any other MCP client can launch `gu serve`.
- **uv** for Python tools, and **Node.js with npm** for Node tools.
- **git** for `gu install github.com/…`.

## Quickstart

1. **Ask your agent.** Tell it "publish ~/code/my-tool with gu". It runs `gu publish`, writes the card, and installs the tool. You don't need to review any YAML.
2. **gu connects itself.** After the first install, gu adds itself to Claude Code (and Codex, if you have it). When you run gu in your own terminal, it asks first.
3. **Just ask for it.** Open a new agent session and say what you want in plain English. Your agent picks the right tool and runs it.
4. **Commit `gu.yaml` and `.gu/test/`.** Then another machine can run `gu install github.com/<owner>/<repo>`.

## Example

A color-matching script, after `gu publish`:

```yaml
name: color-match
version: 1
description: Match one image's colors to another
use_when: The user wants an image to look like a reference image
platforms: [macos, linux]
install: { python: "3.12", pip: "." }
tools:
  - name: match
    run: color-matcher
    args:
      source: { type: path, flag: "-s" }
      reference: { type: path, flag: "-r" }
    returns: Writes <source>_matched.png next to the source image
test:
  run: color-matcher -s .gu/test/a.png -r .gu/test/b.png
  expect: { exit_code: 0, file_exists: ".gu/test/a_matched.png" }
```

In Claude Code, from any project: *"Make beach.png match the colors of sunset.png"*. The agent calls `color-match__match`, and gu returns the output, the files the tool wrote, and the images themselves so the agent can look at them.

## Commands

| Command | What it does |
|---|---|
| `gu publish` | Use the existing `gu.yaml`, or get one written, then install, test and connect. Exit code 2 means the card isn't written yet. |
| `gu publish --redraft` | Ignore the existing `gu.yaml` and write a new one. |
| `gu publish --agent` | Have your agent write the card even when an API key is set. |
| `gu publish --yes` | Don't ask for confirmation (for agents). |
| `gu install <folder>` | Install and test a folder that already has a `gu.yaml`. |
| `gu install github.com/<owner>/<repo>[@ref]` | Clone a repo (optionally at a branch, tag or commit), show what will run, and install every card in it. Add `--yes` to skip the question. |
| `gu uninstall <name>` | Remove an installed tool. |
| `gu status` | List installed tools and any problems, including copies older than their source. |
| `gu register` | Connect gu to Claude Code and Codex, or fix an outdated path. Usually automatic. |
| `gu serve` | The local MCP server your agent talks to. You won't usually run this yourself. |

Installed tools live in `~/.gu/tools/`. Set `GU_HOME` to keep them somewhere else.

## How tools run

- **In your project.** Tools run in the folder your agent is working in, so files they write land where you are. gu lists those files in its reply and attaches any images.
- **Safely for the agent.** Commands run as plain argument lists, without a shell, with no keyboard input and with a time limit, so a tool that waits for input can't hang your agent. Long jobs send progress updates.
- **From a tested copy.** `gu install` copies the tool, sets up its own Python or Node environment, and runs its test from an empty folder before your agent can see it. If you edit the source afterwards, `gu status` and the tool's replies tell you to run `gu install` again.
- **With its secrets.** A card can list the environment variables a tool needs. gu asks for each one once, in your terminal, and stores it in `~/.gu/secrets.json`, readable only by you. Each tool only gets the secrets it lists.

## Who writes the card

By default, your coding agent does. With no API key set, `gu publish` prints the card-writing rules and exits with code 2. The agent writes the card and runs `gu publish --yes`.

If you'd rather gu wrote cards itself, give it an API model. Claude is the default:

```sh
export ANTHROPIC_API_KEY='your key'
export GU_LLM=anthropic
```

Any OpenAI-compatible service works too: set `GU_LLM=openai-compatible` with `GU_LLM_BASE_URL`, `GU_LLM_API_KEY` and `GU_LLM_MODEL`. This sends a few selected files from the repo to that provider and spends API credits. Installing and serving tools never need a key.

## Safety

gu is not a sandbox. Installed tools run with your permissions, and `gu install github.com/…` runs that repo's install and test commands on your machine. Only install repos you trust. gu never runs `brew` or `apt` itself; it tells you what's missing.

## Development

```sh
bun install
bun test
bun run typecheck
bun run build:npm   # the Node bundle published to npm
```

## License

Apache-2.0
