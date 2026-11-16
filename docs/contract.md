# What boqo-local reads and runs

Read from the skills' p0b branches on 2026-11-16 (boqo-clips `0b5c583`, boqo-channel
`fce594a`, boqo-sniper `f0e198c`). When a skill changes one of these, `src/store/*` and
`test/helpers/home.mjs` change with it.

## Read

| Skill | Path under the home | Used for |
|---|---|---|
| boqo-clips | `boqo-clips/runs/<YYYYMMDD-HHMM>-<slug>/clips.json` | clips, scores (`score`, `axes`), `replay.pct`, `judgment.{overall,why}`, `standalone.outcome`, `rendered`, `file`, `thumb`, `seconds`, `window` |
| | `…/words.json`, `asr.json`, `transcript.md` | step 1 done |
| | `…/select-request.md`, `selection.json` | step 2 underway (the agent is reading) |
| | `…/sections.json`, `sec-*`, `whole.*` | step 3 done |
| | `…/render/clip-<nn>/` | a clip is rendering |
| | `…/render.json` `failed[]` | clips that didn't render |
| | `…/info.json` `title` | the title before clips.json exists (nothing else is read: it holds signed stream URLs) |
| | `boqo-clips/runs.md` | the source URL and the posted count per run |
| boqo-sniper | `boqo-sniper/watch/<platform>-<slug>/<UTC stamp>/status.json` | state, channel, `chatPerSec`, `moments`, `updatedAt` (older than 240 s means the watcher died, the skill's own rule) |
| | `…/moments/<stamp>/meta.json`, `.taken` | moments, their score and signal line |
| | `boqo-sniper/clips/<folder>/<moment>/clips.json` | the clip made from a moment |
| boqo-channel | `boqo-channel/runs/<YYYYMMDD-HHMM>/plan.json` | the day's posts, `posted`/`skipped` stamps |
| | `boqo-channel/config.json` `posting` | whether the plan waits for a yes |
| brands | `brands/<name>/brand.json`, `logo.*`, `brands/default.txt` | kits, the default kit |

Bands and grade letters are computed here with the engine's own cut-offs
(`engine/boqo/score-grade.mjs`), since clips.json doesn't store them.

## Never served

`upload-*.json` (live signed upload URLs), `info.json` (signed stream URLs), any
`config.json`, transcripts. The media route serves only video and images inside the home.

## Run

`node ~/.boqo-clips/tools/render.mjs --run <run> --n <list> [--brand <kit>]`, one job at a
time. For another caption style, a one-off kit is written to a scratch home and
`BOQO_HOME` points there, as the skill's onboarding does for samples.

## Gaps on the skills' side

- No progress file: steps are read from files, so "reading line 640 of 1,412" isn't
  possible until the agent writes its progress (proposal E1, `run.json`).
- No per-clip post record in boqo-clips, only a count in runs.md (proposal E2).
- No chat-rate history in boqo-sniper: the server samples `chatPerSec` while it runs, so a
  chart starts when the page opens (proposal E3, `metrics.jsonl`).
- `render.mjs` keeps a clip's old stranger judgment after a re-render.
- Moving a clip's start or end has no model-free command; the chat asks the agent.
