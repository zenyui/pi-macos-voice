# pi-macos-voice

Talk to the [pi](https://github.com/earendil-works/pi-mono) coding agent with your
voice, and have its replies read back to you — using native macOS speech, fully
on-device.

- **Dictation (STT):** speak and your words become prompts.
- **Read-aloud (TTS):** the agent's replies are spoken back.
- **Interrupt anytime:** say "stop" (or "shut up") to cut off a reply.
- **Thinking sound:** a soft ambient tone plays while the agent works.

It ships as a toggleable pi extension backed by a small Swift helper (`swyft`).

---

## Requirements

- **macOS on Apple Silicon (arm64).** The shipped binary is arm64-only.
- **macOS 13+** (uses `Speech.framework` + `AVAudioEngine`).
- **pi** ≥ 0.80.

## Install

```sh
pi install git:github.com/zenyui/pi-macos-voice
```

That's it — pi fetches the package (prebuilt binary and app included) and loads
the extension in every session. Start voice mode with `/voice`; the first time,
macOS asks you to allow **Microphone** and **Speech Recognition** for **Swyft**
(see [Permissions](#permissions)).

To pin a version, append a ref: `pi install git:github.com/zenyui/pi-macos-voice@v0.2.0`.
Remove with `pi remove pi-macos-voice`.

**How it installs:** pi `git clone`s the repo into `~/.pi/agent/git/github.com/zenyui/pi-macos-voice`,
adds it to your settings so it loads every session, and runs `npm install` for
any dependencies (there are none at runtime). The committed `bin/swyft` and
`Swyft.app` come down with the clone, and the extension finds them next to
itself. Because it's a git clone rather than a downloaded archive, macOS doesn't
quarantine the files, so the ad-hoc-signed app runs without notarization.

## Permissions

The first time you start voice mode, macOS prompts for **Microphone** and
**Speech Recognition** access, attributed to **Swyft** (not your terminal).
Click Allow. You can review or change this later in
**System Settings → Privacy & Security → Microphone / Speech Recognition**.

> Why a `.app`? A bare CLI launched from a terminal can't hold its own privacy
> permissions — macOS blames the terminal and hard-crashes. `swyft`'s speech
> features run inside `Swyft.app`, launched so it's its own responsible process.
> Text-to-speech uses the system `say` command and needs no permission.

## Usage

**Toggle with `/voice`** — cycles through three states:

1. **off** → **auto**: speak, and each phrase is sent automatically on a pause.
2. **auto** → **push-to-talk**: your words fill the prompt box; review, then
   press Enter to send.
3. **push-to-talk** → **off**.

The footer shows the current state: `🎙 auto`, `🎙 push`, `🎙 thinking`,
`🎙 speaking`.

**Or ask the agent** — the extension registers a `voice_mode` tool, so you can
just say/type "turn on voice mode" and the agent flips it on.

**Interrupt** — while the agent is thinking or speaking, say **"stop"**,
**"shut up"**, **"cancel"**, or **"wait"**. That aborts the current turn (like
pressing Esc), silences the readback, and flushes anything queued. A bare stop
word only — "stop the server" is treated as a normal request.

Dictated prompts are prefixed with 🎙 so both you and the model can tell they
came from speech, and the model is told to expect transcription quirks and to
keep replies short and speakable.

## How it works

```
   you speak                             you hear
      │                                      ▲
      ▼                                      │
┌───────────┐   NDJSON over    ┌──────────────────────────┐   spawns   ┌────────┐
│ Swyft.app │───unix socket───▶│  extension/index.ts      │──────────▶ │ swyft  │
│  (STT)    │◀──"stop" control─│  (state machine + queue) │            │  tts   │──▶ say
└───────────┘                  └──────────────────────────┘            └────────┘
  mic → SFSpeechRecognizer          pi events (agent_start/end, …)      AVAudioEngine hum
```

- **`swyft`** (Swift, `swyft/`) — one binary, several subcommands:
  - `stt` — capture mic, stream partial/final transcripts as NDJSON.
  - `tts` — read stdin aloud via `say` (killable mid-sentence).
  - `hum` — soft "thinking" tone (synthesized, no permission).
  - `doctor` — request/report mic + speech permissions.
  - `version` — `{name, version, protocol, capabilities}` handshake.
- **`Swyft.app`** — the `stt`/`doctor` executable wrapped in an app bundle so it
  owns its TCC permission identity. Launched with `open`; because that detaches
  stdio, it talks to the extension over a unix socket it connects back to.
- **`extension/`** (TypeScript) — the brain. An event-driven state machine
  (`off / listening / thinking / speaking`, no polling loop) reacts to pi
  lifecycle events and the transcript stream: sends dictation as prompts, reads
  replies through a **speak queue** (so replies never overlap), plays the hum
  while thinking, mutes self-echo while speaking, and handles stop words.

Versions are single-sourced from `package.json`; `npm run build` regenerates the
Swift constant so the binary's `swyft version` stays in sync.

## Configuration

`swyft` subcommands accept flags the extension can pass through:

- `stt --silence-ms <n>` — pause length that commits a phrase (default 1200).
- `stt --locale <id>` — recognizer locale (default `en-US`).
- `stt --on-device` — force on-device recognition.
- `tts --voice <id> --rate <wpm>` — pick a `say` voice / speed.
- `hum --volume <0..1> --interval <sec>` — tune the thinking sound.

## For contributors

Build from source and load the local checkout:

```sh
git clone git@github.com:zenyui/pi-macos-voice.git
cd pi-macos-voice
npm install        # dev types only; runtime deps come from pi
npm run build      # gen-version → swift build -c release → sign → assemble Swyft.app
npm run clean      # remove build artifacts
```

Requires the Xcode command-line tools (`xcode-select --install`). Then load the
local copy without installing the package:

```sh
pi -e /absolute/path/to/pi-macos-voice/extension/index.ts
```

The extension finds its binaries in `bin/` relative to itself, so keep
`extension/` and `bin/` together. `bin/swyft` and `bin/Swyft.app` are committed
so a fresh checkout runs without building, on Apple Silicon.

### Commit conventions

This repo uses [Conventional Commits](https://www.conventionalcommits.org).
Prefix commit subjects with a type, e.g.:

```
feat: add push-to-talk mode
fix: stop word not silencing readback
docs: document install flow
chore: bump dependencies
```

Common types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`.

## Troubleshooting

- **No transcription / permission denied:** open System Settings → Privacy and
  ensure **Swyft** has Microphone and Speech Recognition. Toggle `/voice` off/on.
- **Logs:** the Swift side writes `/tmp/swyft.log`; the bridge writes
  `/tmp/swyft-ext.log`.
- **"binary/app missing":** run `npm run build`.
- **Version mismatch warning:** rebuild (`npm run build`) so binary and
  extension versions match.

## Limitations (v0)

- Apple Silicon only in the committed binary.
- No acoustic echo cancellation: while speaking, only stop words are heard
  (prevents a self-talk feedback loop). Full barge-in would need AEC.
- TTS uses `say`; the higher-quality `AVSpeechSynthesizer` crashes from a CLI
  and is a later upgrade.
