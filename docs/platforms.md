# Platform support

## macOS

- **Apple Silicon or Intel** — the shipped binary is universal (arm64 + x86_64).
- **macOS 13+** (uses `Speech.framework` + `AVAudioEngine`).
- All STT and TTS engines available; see [engines.md](engines.md).

Capabilities are resolved at runtime from the OS version in one place
(`native/Sources/picrophone/Platform.swift`), so `picrophone` adapts across macOS
releases instead of assuming a single environment:

- `availableTTSEngines()` / `preferredTTSEngine()` decide what `--engine auto`
  uses; the extension and `picrophone version` read the same source.
- A `neural` TTS slot is reserved (gated behind `neuralTTSAvailable()`, an
  `@available(macOS 26, *)` check) for the next macOS on-device speech model.

### macOS Tahoe (26) neural text-to-speech

macOS **Tahoe** (version 26) is expected to ship a new higher-quality on-device
neural speech-synthesis model. The codebase is already wired for it so that
turning it on is a localized change, not a refactor:

- **Capability gate** — `neuralTTSAvailable()` in `Platform.swift` is the single
  `@available(macOS 26, *)` check. It currently returns `false` even on Tahoe
  (the API isn't implemented yet); flip its inner `return` to `true` once the
  synthesis API is wired.
- **Engine ordering** — `TTSEngine` lists `neural` first, so
  `availableTTSEngines()` puts it at the front and `--engine auto` /
  `preferredTTSEngine()` will prefer it automatically the moment the gate opens.
  `resolveTTSEngine("neural")` on an older OS degrades gracefully to `av` → `say`.
- **Implementation point** — `speakNeural(...)` in `TTS.swift` is a stub that
  currently delegates to `speakAV(...)`. Replace its body with the real neural
  API; it already accepts the same `voiceId` / `rate` arguments as the other
  engines, so the extension and the `--voice` / `--rate` flags need no changes.
- **Handshake** — `picrophone version` reports `os`, `ttsEngines`, and the
  resolved `ttsEngine`, so the extension sees `neural` show up in the engine
  list on Tahoe without any client-side version sniffing.

Until then, `--engine neural` resolves to `av` (AVSpeechSynthesizer) on Tahoe
and `say` on older systems, so nothing breaks while the model is unavailable.

## Windows

Coming soon. The packaging is already in place — a `picrophone-win32` package is
wired as an `os`-gated optional dependency — but it currently ships no binary.
The native side needs a Windows STT/TTS implementation
(`extension/voice/native/win.ts` is the boundary).

## Known limitations

- The `neural` TTS engine is a reserved stub — it currently falls back to
  `AVSpeechSynthesizer` until the new macOS synthesis API is wired up.
- No acoustic echo cancellation: while speaking, only stop words are heard
  (prevents a self-talk feedback loop). Full barge-in would need AEC.
- Whisper and Qwen rely on the Neural Engine; on Intel Macs they fall back to
  CPU and may be slower (see issue tracker).
