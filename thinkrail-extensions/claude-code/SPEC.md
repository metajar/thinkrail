---
id: module-ext-claude-code
type: module-design
status: draft
title: Claude Code subscription provider (thinkrail-extensions/claude-code)
parent: module-thinkrail-extensions
depends-on: [module-pi-extensions]
tags: [extensions, providers]
---

## Responsibility

Registers a pi provider `claude-code` (models `sonnet`, `opus`, `haiku`) whose completions run through the local
`claude` CLI in print mode (`claude -p --output-format stream-json`). The CLI's own login (claude.ai subscription)
is the credential, so no Anthropic API key is needed.

## Shape

- `./server` only: `defineServerExtension({ name: "claude-code", extensions: [provider] })`. No web half, no tools.
- `claudeCodeProvider.ts` exports `streamClaudeCode` (the `streamSimple` implementation) and the provider factory.

## Rules

- `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` are stripped from the child environment; otherwise the CLI bills the
  API key instead of the subscription.
- Tools: pi tools are offered through a text protocol (`<tool_call name="...">{json}</tool_call>`) and any native
  `tool_use` block the CLI emits is captured as a tool call; the CLI is stopped before its own loop runs (the
  CLI cannot execute pi tools, so it must not try).
- Each call is stateless: the full transcript is sent on stdin; the CLI runs with `--tools ""`,
  `--no-session-persistence`, from `~/.thinkrail/claude-code-provider`.
- Effort: models declare `reasoning: true` with a `thinkingLevelMap` of `low`…`max` (`off`/`minimal` unsupported,
  matching the CLI); the selected level is passed as `claude --effort <level>`.
- Binary: `THINKRAIL_CLAUDE_BIN`, else `claude` on PATH, else `~/.local/bin/claude`.
- Cost is reported as zero (subscription); token usage is reported from the CLI result.

## Tests

`bun test` runs unit tests against a stand-in CLI script. `CLAUDE_CODE_LIVE=1 bun test -t live` round-trips
through the real logged-in CLI and consumes subscription quota.
