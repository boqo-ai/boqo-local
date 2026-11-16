# boqo-local

See what the boqo skills are doing on your computer, and ask your own agent to change your clips.

<!-- demo GIF -->

## Install

It comes with the boqo skills ([boqo-clips](https://github.com/boqo-ai/boqo-clips),
[boqo-channel](https://github.com/boqo-ai/boqo-channel),
[boqo-sniper](https://github.com/boqo-ai/boqo-sniper)). To run it by hand:

```sh
git clone https://github.com/boqo-ai/boqo-local ~/.boqo-local
node ~/.boqo-local/bin/boqo-local.mjs start     # starts once per computer and opens your browser
node ~/.boqo-local/bin/boqo-local.mjs status
node ~/.boqo-local/bin/boqo-local.mjs stop
```

It stops by itself after 30 minutes with no page open and nothing running.

## What it does

- **My Work**: everything the skills did, newest first, grouped by day. A run shows its
  steps while it works and its best clips when it's done; a Stream Sniper watch shows chat
  per second and its moments; a channel plan shows the day's posts.
- **A run**: every clip in boqo's order with its score, the four sub-scores, how much
  viewers replay the part, the stranger judgment and a player. Render a clip that was
  picked but not rendered, or re-render one in another caption style.
- **The chat**: messages go to your agent on this computer (Claude Code, Codex or Cursor)
  with the run and the selected clip as context. The reply, the steps the agent took and
  the cost come back into the page.

## Requirements

- Node 20 or newer. No npm dependencies.
- For local renders: boqo-clips installed (`~/.boqo-clips`, or `BOQO_CLIPS_DIR`).
- For the chat: Claude Code, Codex or Cursor on your PATH. On Windows, an agent installed
  through npm (a `.cmd` shim) can't be started without a shell, so use its own installer.

## What runs where

| Part | Who does it |
|---|---|
| Picking and scoring clips, judging them, posting | Your agent, following the skill. The chat sends it your request, and each message uses your agent's plan (about $0.20 to $0.30 for a short Claude Code turn, measured 2026-11-16). |
| Rendering a clip, another caption style | This computer, through the boqo-clips engine (`tools/render.mjs`). No model, no credits. |
| Reading what happened | This app, from the skills' files in `$BOQO_HOME` (else `~/.boqo`). The skills don't depend on it. What it reads is in [docs/contract.md](docs/contract.md). |

Its own files (settings, chat threads, `server.json`) live in `<home>/local/`.

## Safety

- Listens on 127.0.0.1 only and refuses any other `Host` header.
- Every write needs this page's token in a custom header and this server's own `Origin`.
  The token is only in the served page, never on disk. No CORS.
- Serves only video and images inside the home, after symlinks are resolved. JSON with
  signed upload URLs and config files never leaves the server.
- Starts your agent without a shell. Claude Code gets an allow-list (read files, `node`,
  `ffmpeg`, `yt-dlp`, the boqo MCP tools); Codex runs in its `workspace-write` sandbox;
  Cursor only answers unless you let it run commands.

## Demo

```sh
node scripts/demo.mjs    # fictional example data on http://127.0.0.1:4190
npm test
```

## Licence

MIT, see [LICENSE](LICENSE). © PRAC INC. Made by [boqo](https://boqo.ai).
