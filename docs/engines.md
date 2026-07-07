# Engines

Dictation (STT) and read-aloud (TTS) each have interchangeable back-ends. All run
on-device.

## STT (dictation)

Switch with **`/voice-stt apple`** or **`/voice-stt whisper [model]`** (persisted;
restart voice mode to apply).

| Engine | Notes |
| --- | --- |
| **`whisper`** (default) | Local [WhisperKit](https://github.com/argmaxinc/WhisperKit) — Whisper on the Neural Engine. Mic-only, accurate on accents/jargon, sub-second when warm. |
| **`apple`** | Native `SFSpeechRecognizer`. Zero setup, streaming partials, needs Speech Recognition permission. |

**Whisper models** (download on first use, cached under
`~/Library/Caches/picrophone`) — smaller is faster, larger is more accurate:
`tiny`, `base` (default), `small`, `large`.

## TTS (read-aloud)

Switch with **`/voice-tts auto|av|say|qwen [speaker]`** (persisted, applies
immediately).

| Engine | Notes |
| --- | --- |
| **`av`** (default) | `AVSpeechSynthesizer` using your System Settings voice. Snappy, killable mid-utterance for clean barge-in. |
| **`say`** | `/usr/bin/say`, the always-present fallback. |
| **`qwen`** | On-device Qwen3-TTS via WhisperKit's `TTSKit`. Higher quality but slow to synthesize. Model downloads on first use. |
| **`auto`** | Picks the best engine for your macOS version. |

**Qwen speakers** — pass as a second arg, e.g. `/voice-tts qwen aiden`:
`ryan`, `aiden`, `serena`, `vivian`, `eric`, `dylan`, `sohee`, `ono-anna`,
`uncle-fu` (only `ryan`/`aiden` are native English).
