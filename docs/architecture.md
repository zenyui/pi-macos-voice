# Architecture

How the pieces fit together.

```
   you speak                             you hear
      │                                      ▲
      ▼                                      │
┌────────────────┐  NDJSON over  ┌──────────────────────────┐  spawns  ┌────────────┐
│ Picrophone.app │──unix socket─▶│  extension/index.ts      │─────────▶│ picrophone │
│      (STT)     │◀─"stop" ctrl──│  (state machine + queue) │          │    tts     │──▶ say
└────────────────┘               └──────────────────────────┘          └────────────┘
  mic → SFSpeechRecognizer          pi events (agent_start/end, …)      AVAudioEngine hum
     or WhisperKit (Core ML)
```

## Components

- **`picrophone`** (Swift, `native/`) — one binary, several subcommands:
  - `stt` — capture mic, stream partial/final transcripts as NDJSON.
  - `tts` — read stdin aloud (killable mid-sentence).
  - `hum` — soft "thinking" tone (synthesized, no permission).
  - `doctor` — request/report mic + speech permissions.
  - `version` — `{name, version, protocol, capabilities}` handshake.
- **`Picrophone.app`** — the `stt`/`doctor` executable wrapped in an app bundle so
  it owns its TCC permission identity. Launched with `open`; because that
  detaches stdio, it talks to the extension over a unix socket it connects back
  to.
- **`extension/`** (TypeScript) — the brain. An event-driven state machine
  (`off / listening / thinking / speaking`, no polling loop) reacts to pi
  lifecycle events and the transcript stream: sends dictation as prompts, reads
  replies through a **speak queue** (so replies never overlap), plays the hum
  while thinking, mutes self-echo while speaking, and handles stop words.

## Pluggable engines

STT and TTS both sit behind a common protocol (`extension/voice/protocol.ts`),
so swapping providers is a one-line change. Engines emit the same NDJSON, so the
extension and its state machine are identical regardless of back-end. See
[engines.md](engines.md) for the available ones.

## Versioning

Versions are single-sourced from `package.json`; `npm run build` regenerates the
Swift constant so the binary's `picrophone version` stays in sync. The main
package and every per-platform package are released in lockstep at the same
version. See [contributing.md](contributing.md) for the release flow.

## Why a `.app`?

A bare CLI launched from a terminal can't hold its own privacy permissions —
macOS blames the terminal and hard-crashes. `picrophone`'s speech features run
inside `Picrophone.app`, launched so it's its own responsible process.
Text-to-speech uses the system `say` command and needs no permission.
