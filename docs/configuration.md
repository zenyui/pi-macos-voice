# Configuration

The `picrophone` binary is an internal helper — the extension drives it and
sets these flags for you. You don't call it directly; configure voice mode with
the `/voice-stt` and `/voice-tts` commands (see [engines](engines.md)). This
page is a reference for the flags the extension passes.

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
