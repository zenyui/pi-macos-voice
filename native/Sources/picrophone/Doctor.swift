import Foundation

/// Request both permissions, report status as NDJSON, exit 0 if both authorized.
/// When launched inside an .app via `open`, stdout is detached, so `--out <path>`
/// also writes the JSON result to a file the caller can read.
func runDoctor(_ args: [String] = []) -> Never {
    var outPath: String?
    var i = 0
    while i < args.count {
        if args[i] == "--out" { i += 1; if i < args.count { outPath = args[i] } }
        i += 1
    }

    requestMic { mic in
        requestSpeech { speech in
            let result: [String: Any] = ["type": "permission", "mic": mic, "speech": speech]
            emit(result)
            if let outPath, let data = try? JSONSerialization.data(withJSONObject: result) {
                try? data.write(to: URL(fileURLWithPath: outPath))
            }
            let ok = mic == "authorized" && speech == "authorized"
            exit(ok ? 0 : 1)
        }
    }
    CFRunLoopRun()
    exit(0)
}
