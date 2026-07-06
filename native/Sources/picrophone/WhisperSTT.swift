import AVFoundation
import Foundation
import WhisperKit

/// Local Whisper STT engine (WhisperKit / Core ML — runs on the Neural Engine).
///
/// Mirrors the Apple `Listener` contract: capture the mic, detect utterance
/// boundaries by energy VAD, transcribe on-device, and emit the same NDJSON
/// (`ready`/`partial`/`final`/`warn`). Endpointing matches the Apple engine's
/// "commit on silence" so the extension's state machine is unchanged.
///
/// Flow per utterance:
/// - a 0.2s timer polls `AudioProcessor.relativeEnergy` for voice activity;
/// - while voiced, we periodically transcribe the in-progress slice → `partial`;
/// - after `silence` seconds without voice we transcribe the whole slice once
///   more → `final`, then purge the consumed audio and wait for the next one.
final class WhisperListener: STTListener {
    private let modelName: String
    private let silence: TimeInterval
    private let vadThreshold: Float

    private let audioProcessor = AudioProcessor()
    private var whisperKit: WhisperKit?

    private var voiced = false
    private var utteranceStart = 0          // index into audioProcessor.audioSamples
    private var lastVoiceTime = Date()
    private var lastPartialTime = Date.distantPast
    private var lastText = ""
    private var transcribing = false
    private var generation = 0              // bumped on reset; stale results ignored

    // ~0.5s of 16kHz audio kept before the detected voice onset so we don't clip
    // the first phoneme.
    private let preRollSamples = Int(Double(WhisperKit.sampleRate) * 0.5)
    // Don't transcribe partials more than this often (each decode costs ~0.3s).
    private let partialInterval: TimeInterval = 0.7
    // Ignore utterances shorter than this (spurious blips).
    private let minUtteranceSamples = Int(Double(WhisperKit.sampleRate) * 0.3)

    init(model: String, silenceMs: Int, vadThreshold: Float) {
        self.modelName = model
        self.silence = Double(silenceMs) / 1000.0
        self.vadThreshold = vadThreshold
    }

    func start() {
        emit(["type": "progress", "message": "checking whisper model '\(modelName)'…"])
        Task {
            do {
                let base = Self.modelBaseDir()
                // Phase 1: fetch the model (no-op if already cached). Report
                // real download % so the first run isn't a silent 20–30s stall.
                var lastPct = -1
                let folder = try await WhisperKit.download(variant: modelName, downloadBase: base) { progress in
                    let pct = Int(progress.fractionCompleted * 100)
                    if pct != lastPct {
                        lastPct = pct
                        emit(["type": "progress", "message": "downloading \(self.modelName): \(pct)%"])
                    }
                }
                // Phase 2: load + Core ML specialization (the other slow first-run
                // step — compiles the model for this chip, cached by the OS after).
                emit(["type": "progress", "message": "preparing '\(self.modelName)' (compiling for this Mac)…"])
                let config = WhisperKitConfig(
                    downloadBase: base,
                    modelFolder: folder.path,
                    // Route the tokenizer/vocab download into our cache dir too.
                    // Without this, WhisperKit's Hub defaults to
                    // ~/Documents/huggingface, which trips macOS's Documents-folder
                    // TCC prompt and scatters files outside the cache.
                    tokenizerFolder: base,
                    verbose: false,
                    logLevel: .error,
                    prewarm: false,
                    load: true,
                    download: false
                )
                let wk = try await WhisperKit(config)
                await MainActor.run { self.beginCapture(wk) }
            } catch {
                debugLog("whisper model load failed: \(error.localizedDescription)")
                emit(["type": "warn", "message": "whisper model load failed: \(error.localizedDescription)"])
                exit(1)
            }
        }
    }

    /// Cache dir for downloaded Core ML models. Overrides WhisperKit's default
    /// (`~/Documents/huggingface/...`) with a proper cache location.
    private static func modelBaseDir() -> URL {
        let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
        let dir = base.appendingPathComponent("picrophone", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private func beginCapture(_ wk: WhisperKit) {
        whisperKit = wk
        do {
            try audioProcessor.startRecordingLive(callback: { _ in })
        } catch {
            debugLog("audio processor failed to start: \(error.localizedDescription)")
            emit(["type": "warn", "message": "mic capture failed: \(error.localizedDescription)"])
            exit(1)
        }
        emit(["type": "ready"])
        debugLog("whisper ready; model=\(modelName) silence=\(silence)s vad=\(vadThreshold)")

        let timer = Timer(timeInterval: 0.2, repeats: true) { [weak self] _ in
            self?.tick()
        }
        RunLoop.main.add(timer, forMode: .common)
    }

    private func tick() {
        guard whisperKit != nil, !transcribing else { return }
        let now = Date()
        let count = audioProcessor.audioSamples.count
        let voiceNow = AudioProcessor.isVoiceDetected(
            in: audioProcessor.relativeEnergy,
            nextBufferInSeconds: 0.2,
            silenceThreshold: vadThreshold
        )

        if voiceNow {
            if !voiced {
                voiced = true
                utteranceStart = max(0, count - preRollSamples)
            }
            lastVoiceTime = now
        }

        guard voiced, count - utteranceStart >= minUtteranceSamples else { return }

        // Endpoint: silence long enough after speech → finalize this utterance.
        if now.timeIntervalSince(lastVoiceTime) > silence {
            transcribe(final: true)
            return
        }
        // Otherwise stream an interim partial (throttled).
        if now.timeIntervalSince(lastPartialTime) > partialInterval {
            lastPartialTime = now
            transcribe(final: false)
        }
    }

    private func transcribe(final: Bool) {
        let count = audioProcessor.audioSamples.count
        guard count > utteranceStart else { return }
        let slice = Array(audioProcessor.audioSamples[utteranceStart..<count])
        transcribing = true
        let gen = generation
        let options = DecodingOptions(
            verbose: false,
            task: .transcribe,
            language: "en",
            temperature: 0.0,
            temperatureFallbackCount: final ? 3 : 0,
            usePrefillPrompt: true,
            skipSpecialTokens: true,
            withoutTimestamps: true,
            // Confidence gates: drop low-confidence / non-speech decodes so a
            // silent blip doesn't hallucinate filler ("you", "thank you", …).
            suppressBlank: true,
            compressionRatioThreshold: 2.4,
            logProbThreshold: -1.0,
            firstTokenLogProbThreshold: -1.5,
            noSpeechThreshold: 0.6
        )
        Task {
            var text = ""
            do {
                let results = try await whisperKit!.transcribe(audioArray: slice, decodeOptions: options)
                text = Self.confidentText(from: results)
            } catch {
                debugLog("whisper transcribe error: \(error.localizedDescription)")
            }
            // Whisper hallucinates stock filler on near-silence — discard it.
            let normalized = Self.normalize(text)
            let clean = Self.isHallucination(normalized) ? "" : normalized
            await MainActor.run {
                self.transcribing = false
                // A reset (echo flush) happened while we were decoding — drop it.
                if gen != self.generation { return }
                if final {
                    if !clean.isEmpty {
                        debugLog("whisper final: \(clean)")
                        emit(["type": "final", "text": clean])
                    }
                    // Keep only audio that arrived after this snapshot; start fresh.
                    let tail = self.audioProcessor.audioSamples.count - count
                    self.audioProcessor.purgeAudioSamples(keepingLast: max(0, tail))
                    self.utteranceStart = 0
                    self.voiced = false
                    self.lastText = ""
                    self.lastPartialTime = .distantPast
                } else if !clean.isEmpty, clean != self.lastText {
                    self.lastText = clean
                    debugLog("whisper partial: \(clean)")
                    emit(["type": "partial", "text": clean])
                }
            }
        }
    }

    func reset() {
        // Invalidate any in-flight transcription and skip everything captured so
        // far (e.g. our own TTS the mic picked up).
        generation += 1
        transcribing = false
        utteranceStart = audioProcessor.audioSamples.count
        voiced = false
        lastText = ""
        lastPartialTime = .distantPast
        lastVoiceTime = Date()
        debugLog("whisper reset (echo flushed)")
    }

    /// Strip Whisper's non-speech annotations ("[BLANK_AUDIO]", "(silence)",
    /// music/applause tags) and collapse whitespace.
    private static func normalize(_ raw: String) -> String {
        var s = raw
        s = s.replacingOccurrences(of: "\\[[^\\]]*\\]", with: "", options: .regularExpression)
        s = s.replacingOccurrences(of: "\\([^\\)]*\\)", with: "", options: .regularExpression)
        s = s.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        return s.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // Stock phrases Whisper emits when fed silence/noise (artifacts of its
    // YouTube-heavy training). Almost never a real standalone dictation, so we
    // drop them when they are the ENTIRE transcript.
    private static let hallucinations: Set<String> = [
        "you", "thank you", "thank you.", "thanks for watching",
        "thanks for watching!", "please subscribe", "bye", "bye.",
        "i'm sorry", "you're welcome", ".", "...",
    ]
    private static func isHallucination(_ clean: String) -> Bool {
        let key = clean.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: " .!?,"))
        return hallucinations.contains(clean.lowercased()) || hallucinations.contains(key)
    }

    // Keep only confident, speech-y segments. Whisper hallucinations on silence/
    // echo decode with a high no-speech probability and/or very low average
    // log-prob, so dropping those removes the junk ("you", "Thank you very
    // much", stray "mute", …) from both partials and finals — more general than
    // any fixed word list. Real speech clears these thresholds comfortably.
    private static func confidentText(from results: [TranscriptionResult]) -> String {
        var parts: [String] = []
        for r in results {
            for seg in r.segments {
                if seg.noSpeechProb > 0.6 { continue }
                if seg.avgLogprob < -1.3 { continue }
                parts.append(seg.text)
            }
        }
        return parts.joined(separator: " ")
    }
}
