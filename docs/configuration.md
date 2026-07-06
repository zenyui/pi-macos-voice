# Configuration

## Config file

Voice-mode settings live in `~/.pi/agent/pivoice.json`. Edit it directly (or use
the `/voice-stt` / `/voice-tts` commands). Changes are picked up the next time
voice mode starts (`/voice`), which also validates the file and warns about any
invalid values (falling back to the default for that field).

```json
{
  "version": 1,
  "sttEngine": "whisper",
  "whisperModel": "base.en",
  "ttsEngine": "av",
  "qwenVoice": "aiden"
}
```

| Field | Values | Default | Notes |
| --- | --- | --- | --- |
| `sttEngine` | `whisper` \| `apple` | `whisper` | Dictation back-end. |
| `whisperModel` | `tiny.en`, `base.en`, `small.en`, `large-v3-turbo`, … | `base.en` | Only used when `sttEngine` is `whisper`. |
| `ttsEngine` | `auto` \| `av` \| `say` \| `qwen` | `av` | Read-aloud back-end. |
| `qwenVoice` | `ryan`, `aiden`, `serena`, `vivian`, `eric`, `dylan`, `sohee`, `ono-anna`, `uncle-fu` | `aiden` | Only used when `ttsEngine` is `qwen`. |

See [engines](engines.md) for what each engine does.

## Internal CLI flags

The `picrophone` binary is an internal helper — the extension drives it and
sets these flags for you. You don't call it directly. This section is a
reference for the flags the extension passes.

## `stt`

- `--silence-ms <n>` — pause length that commits a phrase (default 1200).
- `--locale <id>` — recognizer locale (default `en-US`).
- `--on-device` — force on-device recognition (apple engine).
- `--engine <apple|whisper>` — pick the STT back-end (extension default `whisper`).
- `--model <name>` — whisper model (default `base.en`).
- `--vad-threshold <0..1>` — whisper voice-activity energy threshold (default
  0.3; lower = more sensitive).

## `tts`

- `--engine <name>` — `auto` (default) | `neural` | `av` | `say`. `auto` picks
  the best engine available for your macOS version; older systems fall back
  automatically. `picrophone version` reports `os`, `ttsEngines`, and the
  resolved `ttsEngine`.
- `--voice <id> --rate <wpm>` — pick a `say` voice / speed.

## `hum`

- `--volume <0..1> --interval <sec>` — tune the thinking sound.
