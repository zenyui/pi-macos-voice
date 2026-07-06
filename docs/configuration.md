# Configuration

`picrophone` subcommands accept flags the extension passes through.

## `stt`

- `--silence-ms <n>` — pause length that commits a phrase (default 1200).
- `--locale <id>` — recognizer locale (default `en-US`).
- `--on-device` — force on-device recognition (apple engine).
- `--engine <apple|whisper>` — pick the STT back-end (default `apple`).
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
