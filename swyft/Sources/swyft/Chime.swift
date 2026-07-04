import AVFoundation

// Short "I'm listening" earcon: two soft ascending notes, then exit.
// Output-only (no permission).
func runChime(_ args: [String]) -> Never {
    var volume: Float = 0.18
    var i = 0
    while i < args.count {
        if args[i] == "--volume" { i += 1; if i < args.count { volume = Float(args[i]) ?? volume } }
        i += 1
    }

    let engine = AVAudioEngine()
    let output = engine.outputNode
    let format = output.inputFormat(forBus: 0)
    let sr = format.sampleRate > 0 ? format.sampleRate : 48000

    // Ascending perfect fifth (D5 -> A5) reads as "ready / go ahead".
    let notes: [(start: Double, freq: Double)] = [(0.0, 587.33), (0.14, 880.0)]
    let noteDur = 0.32
    let totalDur = 0.55

    var n = 0
    let source = AVAudioSourceNode { _, _, frameCount, abl in
        let buffers = UnsafeMutableAudioBufferListPointer(abl)
        for frame in 0..<Int(frameCount) {
            let t = Double(n) / sr
            var s = 0.0
            for note in notes {
                let dt = t - note.start
                if dt >= 0, dt < noteDur {
                    let env = exp(-5.0 * dt)
                    s += (sin(2 * .pi * note.freq * dt) + 0.3 * sin(2 * .pi * 2 * note.freq * dt)) * env
                }
            }
            let sample = Float(s) * volume
            for buffer in buffers {
                let buf = UnsafeMutableBufferPointer<Float>(buffer)
                if frame < buf.count { buf[frame] = sample }
            }
            n += 1
        }
        return noErr
    }

    engine.attach(source)
    engine.connect(source, to: output, format: format)
    do {
        try engine.start()
    } catch {
        exit(0)
    }
    usleep(useconds_t(totalDur * 1_000_000))
    exit(0)
}
