import Foundation

/// Text-to-speech: read text (from args or stdin) and speak it, blocking until playback ends.
///
/// v0 shells out to the macOS `say` binary: rock-solid, no TCC permission, and
/// no AVSpeechSynthesizer-from-CLI crashes. AVSpeechSynthesizer is a later upgrade.
func runTTS(_ args: [String]) -> Never {
    var voiceId: String?
    var rate: Int? // words per minute for `say -r`
    var words: [String] = []

    var i = 0
    while i < args.count {
        switch args[i] {
        case "--voice": i += 1; if i < args.count { voiceId = args[i] }
        case "--rate": i += 1; if i < args.count { rate = Int(args[i]) }
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

    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/say")
    var sayArgs: [String] = []
    if let voiceId { sayArgs += ["-v", voiceId] }
    if let rate { sayArgs += ["-r", String(rate)] }
    // Pass text via stdin (-f -) to avoid arg length/escaping limits.
    sayArgs += ["-f", "-"]
    process.arguments = sayArgs

    let stdin = Pipe()
    process.standardInput = stdin

    // When the extension kills us (barge-in / stop word), forward the kill to
    // the `say` child — otherwise it keeps talking after we die.
    signal(SIGTERM, SIG_IGN)
    signal(SIGINT, SIG_IGN)
    let onTerm = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
    let onInt = DispatchSource.makeSignalSource(signal: SIGINT, queue: .global())
    let handler = {
        let pid = process.processIdentifier
        if pid > 0 { kill(pid, SIGKILL) } // say ignores SIGTERM; force it
        exit(0)
    }
    onTerm.setEventHandler(handler: handler)
    onInt.setEventHandler(handler: handler)
    onTerm.resume()
    onInt.resume()

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
