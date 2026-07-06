# Engines

Dictation (STT) and read-aloud (TTS) each have interchangeable back-ends. All run
on-device.

## STT (dictation)

Switch with **`/voice-stt apple`** or **`/voice-stt whisper [model]`** (persisted;
restart voice mode to apply).

| Engine | Notes |
| --- | --- |
| **`apple`** (default) | Native `SFSpeechRecognizer`. Zero setup, streaming partials, needs Speech Recognition permission. |
| **`whisper`** | Local [WhisperKit](https://github.com/argmaxinc/WhisperKit) (OpenAI Whisper on Core ML / the Neural Engine). Needs only the mic. Better accuracy on accents/jargon; warm transcription is sub-second on Apple Silicon. |

**Whisper models** (download on first use, cached under
`~/Library/Caches/picrophone`) — smaller is faster, larger is more accurate:
`tiny.en`, `base.en` (default), `small.en`, `large-v3-turbo`, …

## TTS (read-aloud)

Switch with **`/voice-tts auto|av|say|qwen [speaker]`** (persisted, applies
immediately).

| Engine | Notes |
| --- | --- |
| **`av`** (default) | `AVSpeechSynthesizer` with the best installed English voice (add enhanced/premium voices in System Settings › Accessibility › Spoken Content). Snappy, killable mid-utterance for clean barge-in. |
| **`say`** | `/usr/bin/say`, the always-present fallback. |
| **`qwen`** | On-device Qwen3-TTS via WhisperKit's `TTSKit` (Core ML / the Neural Engine). Higher quality but slow to synthesize — not the default. Model downloads on first use (cached under `~/Library/Caches/picrophone`). |
| **`auto`** | Picks the best engine available for your macOS version; older systems fall back automatically. |

**Qwen speakers** — pass as a second arg, e.g. `/voice-tts qwen aiden`:
`ryan`, `aiden`, `serena`, `vivian`, `eric`, `dylan`, `sohee`, `ono-anna`,
`uncle-fu` (only `ryan`/`aiden` are native English).
