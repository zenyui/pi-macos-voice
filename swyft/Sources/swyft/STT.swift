import AVFoundation
import Speech

// Keeps the listener alive past the permission callback (main-queue dispatch).
private var listenerRef: AnyObject?

private final class Listener {
    let engine = AVAudioEngine()
    let recognizer: SFSpeechRecognizer
    let silence: TimeInterval
    let onDevice: Bool

    var currentRequest: SFSpeechAudioBufferRecognitionRequest?
    var task: SFSpeechRecognitionTask?
    var lastText = ""
    var lastUpdate = Date()
    var generation = 0 // bumped each restart; stale-task results are ignored

    init(locale: String, silenceMs: Int, onDevice: Bool) {
        guard let rec = SFSpeechRecognizer(locale: Locale(identifier: locale)) else {
            fail("no recognizer for locale '\(locale)'")
        }
        self.recognizer = rec
        self.silence = Double(silenceMs) / 1000.0
        self.onDevice = onDevice
    }

    func newRequest() {
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        if onDevice {
            if recognizer.supportsOnDeviceRecognition {
                req.requiresOnDeviceRecognition = true
            } else {
                emit(["type": "warn", "message": "on-device recognition unavailable for locale"])
            }
        }
        currentRequest = req
        let gen = generation
        task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            guard let self else { return }
            // Ignore stragglers from a task we already finalized/restarted
            // (the async cancel emits one more echo partial otherwise).
            if gen != self.generation { return }
            if let error {
                debugLog("recognitionTask error: \(error.localizedDescription)")
            }
            guard let result else { return }
            let text = result.bestTranscription.formattedString
            if text != self.lastText {
                self.lastText = text
                self.lastUpdate = Date()
                debugLog("partial: \(text)")
                emit(["type": "partial", "text": text])
            }
        }
    }

    // Throw away whatever the recognizer has accumulated and start a fresh
    // utterance. Called when our own TTS finishes: the mic stays live the whole
    // time (so a spoken stop word can interrupt), but any audio it picked up
    // from our speakers is discarded here instead of finalizing into a message.
    func reset() {
        generation += 1 // invalidate late callbacks from the task we're tearing down
        lastText = ""
        lastUpdate = Date()
        currentRequest?.endAudio()
        task?.cancel()
        newRequest()
        debugLog("stt reset (echo flushed)")
    }

    func finalizeIfSilent() {
        guard !lastText.isEmpty, Date().timeIntervalSince(lastUpdate) > silence else { return }
        let text = lastText
        lastText = ""
        debugLog("final: \(text)")
        emit(["type": "final", "text": text])
        // Restart recognition for the next utterance.
        generation += 1 // invalidate the outgoing task's late callbacks
        currentRequest?.endAudio()
        task?.cancel()
        newRequest()
    }

    func start() {
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            self?.currentRequest?.append(buffer)
        }
        engine.prepare()
        do {
            try engine.start()
        } catch {
            debugLog("audio engine failed to start: \(error.localizedDescription)")
            fail("audio engine failed to start: \(error.localizedDescription)")
        }
        debugLog("audio engine started, format=\(format)")

        newRequest()
        emit(["type": "ready"])
        debugLog("ready; silence=\(silence)s onDevice=\(onDevice)")

        // Timer must be scheduled on a thread with a live run loop; start() runs
        // on the main queue (see runSTT), so this fires on the main run loop.
        let timer = Timer(timeInterval: 0.25, repeats: true) { [weak self] _ in
            self?.finalizeIfSilent()
        }
        RunLoop.main.add(timer, forMode: .common)
    }
}

/// Speech-to-text: capture the mic and stream recognized speech as NDJSON until killed.
func runSTT(_ args: [String]) -> Never {
    var locale = "en-US"
    var silenceMs = 1200
    var onDevice = true
    var socketPath: String?

    var i = 0
    while i < args.count {
        switch args[i] {
        case "--socket": i += 1; if i < args.count { socketPath = args[i] }
        case "--locale": i += 1; if i < args.count { locale = args[i] }
        case "--silence-ms": i += 1; if i < args.count { silenceMs = Int(args[i]) ?? silenceMs }
        case "--on-device": onDevice = true
        default: break
        }
        i += 1
    }

    // In socket mode, route NDJSON to the extension's socket and take control
    // lines back ("stop" ends the session; EOF means the extension went away).
    debugLog("stt starting: socket=\(socketPath ?? "(stdout)") locale=\(locale) silenceMs=\(silenceMs) onDevice=\(onDevice)")
    if let socketPath {
        guard let client = UnixSocketClient(path: socketPath) else {
            debugLog("could not connect to socket \(socketPath)")
            fail("could not connect to socket \(socketPath)")
        }
        debugLog("connected to socket")
        jsonSink = { client.writeLine($0) }
        client.readLines(
            onLine: { line in
                switch line {
                case "stop": exit(0)
                case "reset":
                    DispatchQueue.main.async { (listenerRef as? Listener)?.reset() }
                default: break
                }
            },
            onClose: { exit(0) }
        )
    }

    requestMic { mic in
        requestSpeech { speech in
            debugLog("permissions: mic=\(mic) speech=\(speech)")
            if mic != "authorized" || speech != "authorized" {
                emit(["type": "permission", "mic": mic, "speech": speech])
                exit(1)
            }
            // Engine + Timer must run on the main run loop.
            DispatchQueue.main.async {
                let listener = Listener(locale: locale, silenceMs: silenceMs, onDevice: onDevice)
                listenerRef = listener
                listener.start()
            }
        }
    }

    CFRunLoopRun() // runs until the process is killed (barge-in / voice off)
    exit(0)
}
