# File Doorbell

A cross-substrate coding-agent skill that turns appended signal-file lines into visible agent turns.

- Claude Code uses its persistent `Monitor` tool.
- Codex desktop uses the included Node adapter and local desktop IPC.
- Grok can use its native persistent monitor.
- Codex CLI and agy are documented as unsupported until their hosts expose a proven live-turn adapter.

Install this repository as `file-doorbell` in the host's normal skill directory, then ask the agent to arm or test a file doorbell. The skill requires an existing newline-delimited signal file and performs its own after-idle proof.

The signal file is transport only. Routing, mailboxes, senders, tmux injection, and messaging systems are intentionally outside this package.

## License

MIT
