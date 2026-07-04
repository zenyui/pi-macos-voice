import Foundation

// Version is injected at build time via gen-version (see scripts/gen-version.mjs),
// which writes Version.swift from package.json. Do not hand-edit.

/// Append a timestamped debug line to a log file (STT runs headless under
/// `open`, so stderr is invisible). Path overridable via SWYFT_LOG.
let swyftLogPath = ProcessInfo.processInfo.environment["SWYFT_LOG"] ?? "/tmp/swyft.log"

func debugLog(_ message: String) {
    let ts = ISO8601DateFormatter().string(from: Date())
    let line = "[\(ts)] \(message)\n"
    if let data = line.data(using: .utf8) {
        if let handle = FileHandle(forWritingAtPath: swyftLogPath) {
            handle.seekToEndOfFile()
            handle.write(data)
            try? handle.close()
        } else {
            try? data.write(to: URL(fileURLWithPath: swyftLogPath))
        }
    }
}

/// When set (STT socket mode), NDJSON is routed here instead of stdout.
var jsonSink: ((String) -> Void)?

/// Emit one NDJSON object to the active sink (stdout by default), flushed.
func emit(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj),
          let line = String(data: data, encoding: .utf8) else {
        return
    }
    if let jsonSink {
        jsonSink(line)
    } else {
        print(line)
        fflush(stdout)
    }
}

func fail(_ message: String, code: Int32 = 1) -> Never {
    FileHandle.standardError.write(Data("swyft: \(message)\n".utf8))
    exit(code)
}

let args = Array(CommandLine.arguments.dropFirst())
let command = args.first ?? "help"
let rest = Array(args.dropFirst())

switch command {
case "version":
    emit([
        "name": "swyft",
        "version": swyftVersion,
        "protocol": swyftProtocol,
        "capabilities": ["version", "tts", "stt", "doctor", "hum", "chime"],
    ])
    exit(0)

case "tts":
    runTTS(rest)

case "stt":
    runSTT(rest)

case "hum":
    runHum(rest)

case "chime":
    runChime(rest)

case "doctor":
    runDoctor(rest)

case "help", "-h", "--help":
    FileHandle.standardError.write(Data("""
    swyft \(swyftVersion)
    usage: swyft <command> [options]
      version                 print version/protocol/capabilities as JSON
      tts [text]              text-to-speech: read <text> (or stdin) aloud; blocks until done
        --voice <id>          voice identifier (default: system)
        --rate <wpm>          words per minute (default: system)
      stt                     speech-to-text: stream recognized speech as NDJSON
        --socket <path>       connect to a unix socket for NDJSON + control (else stdout)
        --locale <id>         recognizer locale (default: en-US)
        --silence-ms <n>      commit-on-silence threshold (default: 1200)
        --on-device           force on-device recognition
      hum                     play a soft ambient thinking sound until killed
        --volume <0..1>       loudness (default: 0.05)
      chime                   play a short "listening" earcon and exit
        --volume <0..1>       loudness (default: 0.18)
      doctor                  request/report mic + speech permissions as JSON

    """.utf8))
    exit(0)

default:
    fail("unknown command '\(command)'", code: 64)
}
