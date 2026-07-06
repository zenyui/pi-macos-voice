<p align="center">
  <a href="https://pi.dev">
    <img alt="picrophone logo" src="assets/pi-voice-logo.svg" width="340">
  </a>
</p>

# picrophone

Talk to the [pi](https://github.com/earendil-works/pi) coding agent with your
voice, and have its replies read back to you — fully on-device.

- **Dictation (STT):** speak and your words become prompts.
- **Read-aloud (TTS):** the agent's replies are spoken back.
- **Pluggable engines:** STT and TTS sit behind a common protocol; swap with one
  command.
- **Interrupt anytime:** say "stop" (or "shut up") to cut off a reply.
- **Mute:** say "mute"/"unmute", or run `/mute`, to pause listening without
  leaving voice mode.
- **Thinking sound:** a soft ambient tone plays while the agent works.

It ships as a toggleable pi extension backed by a small native helper.

---

## Quickstart

```sh
pi install npm:picrophone
```

Then run pi, type `/voice`, and click **Allow** when macOS asks for Microphone +
Speech Recognition (for **Picrophone**). Now just talk:

- Speak your request — on a short pause it's sent automatically.
- Say **"stop"** (or "shut up") to cut off a reply.
- Say **"mute"** / **"unmute"** (or run `/mute`) to pause/resume listening.
- Run `/voice` again to switch to push-to-talk (review before Enter), and once
  more to turn voice off. A soft chime means it's listening again.

To pin a version: `pi install npm:picrophone@0.8.1`. Remove with
`pi remove npm:picrophone`.

---

## Platforms

### macOS (supported)

- **Apple Silicon or Intel** — universal binary (arm64 + x86_64), **macOS 13+**.
- **Dictation:** `whisper` (local [WhisperKit](https://github.com/argmaxinc/WhisperKit),
  default; models `tiny.en` → `large-v3-turbo`) or `apple` (native
  `SFSpeechRecognizer`).
- **Read-aloud:** `av` (`AVSpeechSynthesizer`, default), `say`, or `qwen`
  (on-device Qwen3-TTS).

Switch engines with `/voice-stt` and `/voice-tts`. Full engine and model
reference: **[docs/engines.md](docs/engines.md)**.

### Windows (coming soon)

Packaging is wired up (an `os`-gated optional dependency), but no binary ships
yet. See **[docs/platforms.md](docs/platforms.md)**.

---

## Usage

**Toggle with `/voice`** — cycles: **off** → **auto** (sends on pause) →
**push-to-talk** (fills the prompt box; press Enter to send) → **off**. The
footer shows the state: `🎙 auto`, `🎙 push`, `🎙 thinking`, `🎙 speaking`,
`🔇 muted`.

**Or ask the agent** — the extension registers a `voice_mode` tool, so you can
just say/type "turn on voice mode".

**Interrupt** — while the agent is thinking or speaking, say **"stop"**, **"shut
up"**, **"cancel"**, or **"wait"** to abort the turn and silence the readback. A
bare stop word only — "stop the server" is a normal request.

Dictated prompts are prefixed with 🎙 so both you and the model know they came
from speech.

## Permissions

The first time you start voice mode, macOS prompts for **Microphone** and
**Speech Recognition**, attributed to **Picrophone** (not your terminal). Click
Allow; review later in **System Settings → Privacy & Security**. Text-to-speech
needs no permission. Why a `.app`? See
[docs/architecture.md](docs/architecture.md#why-a-app).

## Docs

- **[Architecture](docs/architecture.md)** — how the pieces fit together.
- **[Engines](docs/engines.md)** — STT/TTS back-ends and models.
- **[Configuration](docs/configuration.md)** — subcommand flags.
- **[Platform support](docs/platforms.md)** — macOS/Windows, macOS Tahoe neural
  TTS, limitations.
- **[Troubleshooting](docs/troubleshooting.md)** — logs, common issues, bug
  reports.
- **[Contributing](docs/contributing.md)** — build from source, packaging,
  releasing.

## Feedback

Feature requests and bug reports go in
[GitHub Issues](https://github.com/zenyui/picrophone/issues) — see
[docs/troubleshooting.md](docs/troubleshooting.md#reporting-a-bug) for what to
include.
