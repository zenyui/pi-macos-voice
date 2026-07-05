import AVFoundation

// Text-to-speech. Two engines:
//   --engine av  (default) AVSpeechSynthesizer — higher-quality system voices,
//                 in-process so a kill stops audio instantly (clean barge-in).
//   --engine say           shell out to /usr/bin/say (fallback).
// Reads text from args or stdin; blocks until playback ends.

private final class AVDelegate: NSObject, AVSpeechSynthesizerDelegate {
    func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) {
        CFRunLoopStop(CFRunLoopGetMain())
    }
    func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel u: AVSpeechUtterance) {
        CFRunLoopStop(CFRunLoopGetMain())
    }
}

// Strong refs so they survive until the run loop stops.
private var avSynth: AVSpeechSynthesizer?
private var avDelegate: AVDelegate?

private func installExitOnSignal() {
    // Barge-in: the extension kills us; exit stops in-process audio immediately.
    signal(SIGTERM, SIG_IGN)
    signal(SIGINT, SIG_IGN)
    for sig in [SIGTERM, SIGINT] {
        let src = DispatchSource.makeSignalSource(signal: sig, queue: .global())
        src.setEventHandler { exit(0) }
        src.resume()
        // Keep the source alive.
        signalSources.append(src)
    }
}
private var signalSources: [DispatchSourceSignal] = []

// Best English voice the user has installed, but ONLY if it's better than the
// stock default (enhanced/premium) — otherwise return nil so we fall back to the
// system default voice instead of an arbitrary novelty voice. Prefer en-US.
// Users add enhanced/premium voices in System Settings > Accessibility > Spoken.
private func bestEnglishVoice() -> AVSpeechSynthesisVoice? {
    let good = AVSpeechSynthesisVoice.speechVoices().filter {
        $0.language.hasPrefix("en") && $0.quality != .default
    }
    let ranked = good.sorted { $0.quality.rawValue > $1.quality.rawValue }
    return ranked.first { $0.language == "en-US" } ?? ranked.first
}

private func speakAV(_ text: String, voiceId: String?, rate: Float?) -> Never {
    let synth = AVSpeechSynthesizer()
    let delegate = AVDelegate()
    synth.delegate = delegate
    avSynth = synth
    avDelegate = delegate

    let utterance = AVSpeechUtterance(string: text)
    if let voiceId, let voice = AVSpeechSynthesisVoice(identifier: voiceId) {
        utterance.voice = voice
    } else {
        utterance.voice = bestEnglishVoice() ?? AVSpeechSynthesisVoice(language: "en-US")
    }
    if let rate { utterance.rate = max(0, min(1, rate)) }

    installExitOnSignal()
    synth.speak(utterance)
    CFRunLoopRun() // stopped by the delegate on finish/cancel
    exit(0)
}

private func speakSay(_ text: String, voiceId: String?, rate: Int?) -> Never {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/say")
    var sayArgs: [String] = []
    if let voiceId { sayArgs += ["-v", voiceId] }
    if let rate { sayArgs += ["-r", String(rate)] }
    sayArgs += ["-f", "-"]
    process.arguments = sayArgs

    let stdin = Pipe()
    process.standardInput = stdin

    signal(SIGTERM, SIG_IGN)
    signal(SIGINT, SIG_IGN)
    let handler = {
        let pid = process.processIdentifier
        if pid > 0 { kill(pid, SIGKILL) } // say ignores SIGTERM; force it
        exit(0)
    }
    for sig in [SIGTERM, SIGINT] {
        let src = DispatchSource.makeSignalSource(signal: sig, queue: .global())
        src.setEventHandler(handler: handler)
        src.resume()
        signalSources.append(src)
    }

    do {
        try process.run()
    } catch {
        fail("failed to launch say: \(error.localizedDescription)")
    }
    stdin.fileHandleForWriting.write(Data(text.utf8))
    stdin.fileHandleForWriting.closeFile()
    process.waitUntilExit()
    exit(process.terminationStatus)
}

// List installed voices as NDJSON so the extension/user can pick one.
func runVoices() -> Never {
    for v in AVSpeechSynthesisVoice.speechVoices() {
        let quality: String
        switch v.quality {
        case .premium: quality = "premium"
        case .enhanced: quality = "enhanced"
        default: quality = "default"
        }
        emit(["id": v.identifier, "name": v.name, "language": v.language, "quality": quality])
    }
    exit(0)
}

func runTTS(_ args: [String]) -> Never {
    var engine = "av"
    var voiceId: String?
    var rateArg: String?
    var words: [String] = []

    var i = 0
    while i < args.count {
        switch args[i] {
        case "--engine": i += 1; if i < args.count { engine = args[i] }
        case "--voice": i += 1; if i < args.count { voiceId = args[i] }
        case "--rate": i += 1; if i < args.count { rateArg = args[i] }
        default: words.append(args[i])
        }
        i += 1
    }

    var text = words.joined(separator: " ")
    if text.isEmpty {
        let data = FileHandle.standardInput.readDataToEndOfFile()
        text = String(data: data, encoding: .utf8) ?? ""
    }
    text = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if text.isEmpty { exit(0) }

    if engine == "say" {
        speakSay(text, voiceId: voiceId, rate: rateArg.flatMap { Int($0) })
    } else {
        speakAV(text, voiceId: voiceId, rate: rateArg.flatMap { Float($0) })
    }
}
