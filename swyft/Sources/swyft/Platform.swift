import Foundation

// Version-aware capability layer. Central place that answers "what can this
// macOS do?" so both the version handshake and the per-command engine
// selection stay in sync. When a new macOS ships better speech models, gate
// them here (one `@available` check) and the rest of the code adapts.

/// The running macOS version, as reported by the OS at runtime.
struct OSVersion {
    let major: Int
    let minor: Int
    let patch: Int

    static let current: OSVersion = {
        let v = ProcessInfo.processInfo.operatingSystemVersion
        return OSVersion(major: v.majorVersion, minor: v.minorVersion, patch: v.patchVersion)
    }()

    var string: String { "\(major).\(minor).\(patch)" }
}

// MARK: - TTS engines

/// Available text-to-speech backends, best-first when auto-selected.
enum TTSEngine: String, CaseIterable {
    /// New on-device neural speech model. Reserved for the macOS release that
    /// exposes it — see `neuralTTSAvailable()`. Not wired up yet.
    case neural
    /// AVSpeechSynthesizer — in-process system voices (enhanced/premium if the
    /// user installed them). Killable mid-utterance for clean barge-in.
    case av
    /// /usr/bin/say — always-present fallback.
    case say
}

/// Whether the new neural TTS model is usable on this OS.
///
/// The next macOS is expected to ship a higher-quality on-device speech model
/// for synthesis. When its API is available, flip the inner `return` to `true`
/// and implement `speakNeural(...)` in TTS.swift. The version gate lives here so
/// nothing else needs an `#available` check.
func neuralTTSAvailable() -> Bool {
    if #available(macOS 26, *) {
        // TODO: return true once the new synthesis API is implemented.
        return false
    }
    return false
}

/// Engines that actually work on this machine, best-first.
func availableTTSEngines() -> [TTSEngine] {
    var engines: [TTSEngine] = []
    if neuralTTSAvailable() { engines.append(.neural) }
    engines.append(.av)
    engines.append(.say)
    return engines
}

/// The engine `--engine auto` resolves to on this OS.
func preferredTTSEngine() -> TTSEngine {
    availableTTSEngines().first ?? .av
}

/// Resolve a user-supplied `--engine` value (including "auto") to a concrete,
/// available engine, degrading gracefully if the requested one isn't usable.
func resolveTTSEngine(_ requested: String) -> TTSEngine {
    if requested == "auto" { return preferredTTSEngine() }
    guard let engine = TTSEngine(rawValue: requested) else { return preferredTTSEngine() }
    // Requested a real engine but it's not available here (e.g. neural on an
    // older OS) — fall back to the best available.
    if availableTTSEngines().contains(engine) { return engine }
    return preferredTTSEngine()
}
