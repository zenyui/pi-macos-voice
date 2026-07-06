<p align="center">
  <a href="https://pi.dev">
    <img alt="picrophone logo" src="assets/pi-voice-logo.svg" width="340">
  </a>
</p>

# picrophone

Talk to the [pi](https://github.com/earendil-works/pi) coding agent with your
voice, and have its replies read back to you — fully on-device.

- **Dictation (STT):** speak and your words become prompts. Pick your engine —
  native macOS `SFSpeechRecognizer` or local [Whisper](https://github.com/argmaxinc/WhisperKit)
  (OpenAI's model on Core ML / the Neural Engine).
- **Read-aloud (TTS):** the agent's replies are spoken back via native macOS voices.
- **Pluggable engines:** STT and TTS both sit behind a common protocol, so
  swapping providers is a one-line change (`/voice-stt apple|whisper`).
- **Interrupt anytime:** say "stop" (or "shut up") to cut off a reply.
- **Mute/unmute:** say "mute" to pause listening, "unmute" to resume.
- **Thinking sound:** a soft ambient tone plays while the agent works.

It ships as a toggleable pi extension backed by a small Swift helper (`picrophone`).

---

## Quickstart

1. **Install pi** (if you haven't):
   ```sh
   npm install -g --ignore-scripts @earendil-works/pi-coding-agent
   ```
2. **Add the voice bridge:**
   ```sh
   pi install git:github.com/zenyui/picrophone
   ```
3. **Turn it on:** run pi, type `/voice`, and click Allow when macOS asks for
   Microphone + Speech Recognition (for **Picrophone**).

Then just talk:

- Speak your request — on a short pause it's sent automatically.
- Say **"stop"** (or "shut up") to cut off a reply.
- Say **"mute"** to pause listening, **"unmute"** to resume.
- Run `/voice` again to switch to push-to-talk (review before Enter), and once
  more to turn voice off. A soft chime means it's listening again.

---

## Requirements

- **macOS on Apple Silicon (arm64).** The shipped binary is arm64-only.
- **macOS 13+** (uses `Speech.framework` + `AVAudioEngine`).
- **pi** ≥ 0.80.

## Install

```sh
pi install git:github.com/zenyui/picrophone
```

That's it — pi fetches the package (prebuilt binary and app included) and loads
the extension in every session. Start voice mode with `/voice`; the first time,
macOS asks you to allow **Microphone** and **Speech Recognition** for **Picrophone**
(see [Permissions](#permissions)).

To pin a version, append a ref: `pi install git:github.com/zenyui/picrophone@v0.2.0`.
Remove with `pi remove picrophone`.

**How it installs:** pi `git clone`s the repo into `~/.pi/agent/git/github.com/zenyui/picrophone`,
adds it to your settings so it loads every session, and runs `npm install` for
any dependencies (there are none at runtime). The committed `bin/picrophone` and
`Picrophone.app` come down with the clone, and the extension finds them next to
itself. Because it's a git clone rather than a downloaded archive, macOS doesn't
quarantine the files, so the ad-hoc-signed app runs without notarization.

## Permissions

The first time you start voice mode, macOS prompts for **Microphone** and
**Speech Recognition** access, attributed to **Picrophone** (not your terminal).
Click Allow. You can review or change this later in
**System Settings → Privacy & Security → Microphone / Speech Recognition**.

> Why a `.app`? A bare CLI launched from a terminal can't hold its own privacy
> permissions — macOS blames the terminal and hard-crashes. `picrophone`'s speech
> features run inside `Picrophone.app`, launched so it's its own responsible process.
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
┌────────────────┐  NDJSON over  ┌──────────────────────────┐  spawns  ┌────────────┐
│ Picrophone.app │──unix socket─▶│  extension/index.ts      │─────────▶│ picrophone │
│      (STT)     │◀─"stop" ctrl──│  (state machine + queue) │          │    tts     │──▶ say
└────────────────┘               └──────────────────────────┘          └────────────┘
  mic → SFSpeechRecognizer          pi events (agent_start/end, …)      AVAudioEngine hum
     or WhisperKit (Core ML)
```

- **`picrophone`** (Swift, `native/`) — one binary, several subcommands:
  - `stt` — capture mic, stream partial/final transcripts as NDJSON.
  - `tts` — read stdin aloud via `say` (killable mid-sentence).
  - `hum` — soft "thinking" tone (synthesized, no permission).
  - `doctor` — request/report mic + speech permissions.
  - `version` — `{name, version, protocol, capabilities}` handshake.
- **`Picrophone.app`** — the `stt`/`doctor` executable wrapped in an app bundle so it
  owns its TCC permission identity. Launched with `open`; because that detaches
  stdio, it talks to the extension over a unix socket it connects back to.
- **`extension/`** (TypeScript) — the brain. An event-driven state machine
  (`off / listening / thinking / speaking`, no polling loop) reacts to pi
  lifecycle events and the transcript stream: sends dictation as prompts, reads
  replies through a **speak queue** (so replies never overlap), plays the hum
  while thinking, mutes self-echo while speaking, and handles stop words.

Versions are single-sourced from `package.json`; `npm run build` regenerates the
Swift constant so the binary's `picrophone version` stays in sync.

## STT engines

Dictation has two interchangeable back-ends, both fully on-device. They emit
the same NDJSON protocol, so the extension and its state machine are identical
for both:

- **`apple`** (default) — native `SFSpeechRecognizer`. Zero setup, streaming
  partials, needs Speech Recognition permission.
- **`whisper`** — local [WhisperKit](https://github.com/argmaxinc/WhisperKit)
  (OpenAI Whisper on Core ML / the Neural Engine). Needs only the mic. The
  model downloads on first use (`base.en` ≈ small; cached under
  `~/Library/Caches/picrophone`). Better accuracy on accents/jargon; warm
  transcription is sub-second on Apple Silicon.

Switch with **`/voice-stt apple`** or **`/voice-stt whisper [model]`**
(persisted). Models: `tiny.en`, `base.en`, `small.en`, `large-v3-turbo`, … —
smaller is faster, larger is more accurate. Restart voice mode to apply.

## TTS engines

Read-aloud has three back-ends. Switch with **`/voice-tts auto|av|say|qwen`**
(persisted, applies immediately):

- **`av`** (default) — `AVSpeechSynthesizer` with the best installed English
  voice (add enhanced/premium voices in System Settings › Accessibility ›
  Spoken Content). Snappy, killable mid-utterance for clean barge-in.
- **`say`** — `/usr/bin/say`, the always-present fallback.
- **`qwen`** — on-device Qwen3-TTS via WhisperKit's `TTSKit` (Core ML / the
  Neural Engine). Model downloads on first use (cached under
  `~/Library/Caches/picrophone`). Pass a speaker as a second arg, e.g.
  **`/voice-tts qwen aiden`** (speakers: `ryan`, `aiden`, `serena`, `vivian`,
  `eric`, `dylan`, `sohee`, `ono-anna`, `uncle-fu`; only `ryan`/`aiden` are
  native English). Higher quality but slow to synthesize — not the default.

## Configuration

`picrophone` subcommands accept flags the extension can pass through:

- `stt --silence-ms <n>` — pause length that commits a phrase (default 1200).
- `stt --locale <id>` — recognizer locale (default `en-US`).
- `stt --on-device` — force on-device recognition (apple engine).
- `stt --engine <apple|whisper>` — pick the STT back-end (default `apple`).
- `stt --model <name>` — whisper model (default `base.en`).
- `stt --vad-threshold <0..1>` — whisper voice-activity energy threshold
  (default 0.3; lower = more sensitive).
- `tts --engine <name>` — `auto` (default) | `neural` | `av` | `say`. `auto`
  picks the best engine available for your macOS version; older systems fall
  back automatically. `picrophone version` reports `os`, `ttsEngines`, and the
  resolved `ttsEngine`.
- `tts --voice <id> --rate <wpm>` — pick a `say` voice / speed.
- `hum --volume <0..1> --interval <sec>` — tune the thinking sound.

## Feedback & issues

We track **feature requests and bug reports in [GitHub Issues](https://github.com/zenyui/picrophone/issues)**.
Before opening a new one, search existing issues to avoid duplicates. Please
include your macOS version (`sw_vers`), `picrophone version` output, and the relevant
lines from `/tmp/picrophone.log` / `/tmp/picrophone-ext.log` when reporting a bug.

## For contributors

Build from source and load the local checkout:

```sh
git clone git@github.com:zenyui/picrophone.git
cd picrophone
npm install        # dev types only; runtime deps come from pi
npm run build      # gen-version → swift build -c release → sign → assemble Picrophone.app
npm run clean      # remove build artifacts
```

Requires the Xcode command-line tools (`xcode-select --install`). Then load the
local copy without installing the package:

```sh
pi -e /absolute/path/to/picrophone/extension/index.ts
```

The extension finds its binaries in `bin/` relative to itself, so keep
`extension/` and `bin/` together. `bin/picrophone` and `bin/Picrophone.app` are committed
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
  ensure **Picrophone** has Microphone and Speech Recognition. Toggle `/voice` off/on.
- **Logs:** the Swift side writes `/tmp/picrophone.log`; the bridge writes
  `/tmp/picrophone-ext.log`.
- **"binary/app missing":** run `npm run build`.
- **Version mismatch warning:** rebuild (`npm run build`) so binary and
  extension versions match.

## macOS version support

Capabilities are resolved at runtime from the OS version in one place
(`native/Sources/picrophone/Platform.swift`), so `picrophone` adapts across macOS releases
instead of assuming a single environment:

- `availableTTSEngines()` / `preferredTTSEngine()` decide what `--engine auto`
  uses; the extension and `picrophone version` read the same source.
- A `neural` TTS slot is reserved (gated behind `neuralTTSAvailable()`, an
  `@available(macOS 26, *)` check) for the next macOS on-device speech model.
  When that API ships, implement `speakNeural(...)` in `TTS.swift` and flip the
  gate — no other call sites change, and older systems keep falling back to
  `av`/`say`.

### macOS Tahoe (26) neural text-to-speech

macOS **Tahoe** (version 26) is expected to ship a new higher-quality on-device
neural speech-synthesis model. The codebase is already wired for it so that
turning it on is a localized change, not a refactor:

- **Capability gate** — `neuralTTSAvailable()` in `Platform.swift` is the single
  `@available(macOS 26, *)` check. It currently returns `false` even on Tahoe
  (the API isn't implemented yet); flip its inner `return` to `true` once the
  synthesis API is wired.
- **Engine ordering** — `TTSEngine` lists `neural` first, so `availableTTSEngines()`
  puts it at the front and `--engine auto` / `preferredTTSEngine()` will prefer
  it automatically the moment the gate opens. `resolveTTSEngine("neural")` on an
  older OS degrades gracefully to `av` → `say`.
- **Implementation point** — `speakNeural(...)` in `TTS.swift` is a stub that
  currently delegates to `speakAV(...)`. Replace its body with the real neural
  API; it already accepts the same `voiceId` / `rate` arguments as the other
  engines, so the extension and the `--voice` / `--rate` flags need no changes.
- **Handshake** — `picrophone version` reports `os`, `ttsEngines`, and the resolved
  `ttsEngine`, so the extension sees `neural` show up in the engine list on
  Tahoe without any client-side version sniffing.

Until then, `--engine neural` resolves to `av` (AVSpeechSynthesizer) on Tahoe and
`say` on older systems, so nothing breaks while the model is unavailable.

## Limitations (v0)

- Apple Silicon only in the committed binary.
- The `neural` TTS engine is a reserved stub — it currently falls back to
  AVSpeechSynthesizer until the new macOS synthesis API is wired up.
- No acoustic echo cancellation: while speaking, only stop words are heard
  (prevents a self-talk feedback loop). Full barge-in would need AEC.
- TTS uses `say`; the higher-quality `AVSpeechSynthesizer` crashes from a CLI
  and is a later upgrade.
