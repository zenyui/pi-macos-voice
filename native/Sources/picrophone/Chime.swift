import AVFoundation

// Short "I'm listening" earcon, several selectable styles. Output-only.
func runChime(_ args: [String]) -> Never {
    var volume: Float = 0.18
    var style = "fifth"
    var i = 0
    while i < args.count {
        switch args[i] {
        case "--volume": i += 1; if i < args.count { volume = Float(args[i]) ?? volume }
        case "--style": i += 1; if i < args.count { style = args[i] }
        default: break
        }
        i += 1
    }

    // (startSeconds, frequencyHz)
    let notes: [(Double, Double)]
    switch style {
    case "triad":  notes = [(0.0, 523.25), (0.10, 659.25), (0.20, 783.99)]         // C-E-G arpeggio
    case "ping":   notes = [(0.0, 1046.50)]                                        // single high bell
    case "bloop":  notes = [(0.0, 783.99), (0.12, 1046.50)]                        // G5 -> C6
    case "blip":   notes = [(0.0, 1046.50), (0.10, 1318.51)]                       // C6 -> E6, higher
    case "pop":    notes = [(0.0, 880.0), (0.10, 1318.51)]                         // A5 -> E6, wider
    case "dew":    notes = [(0.0, 1046.50), (0.10, 1567.98)]                       // C6 -> G6, bright
    case "glass":  notes = [(0.0, 659.25), (0.11, 987.77)]                         // E5 -> B5, shimmery
    case "down":   notes = [(0.0, 880.0), (0.14, 587.33)]                          // A5 -> D5 descending
    default:       notes = [(0.0, 587.33), (0.14, 880.0)]                          // "fifth": D5 -> A5
    }
    let shimmer = style == "glass"

    let engine = AVAudioEngine()
    let output = engine.outputNode
    let format = output.inputFormat(forBus: 0)
    let sr = format.sampleRate > 0 ? format.sampleRate : 48000
    let noteDur = 0.32
    let lastStart = notes.map { $0.0 }.max() ?? 0
    let totalDur = lastStart + 0.45

    var n = 0
    let source = AVAudioSourceNode { _, _, frameCount, abl in
        let buffers = UnsafeMutableAudioBufferListPointer(abl)
        for frame in 0..<Int(frameCount) {
            let t = Double(n) / sr
            var s = 0.0
            for (start, freq) in notes {
                let dt = t - start
                if dt >= 0, dt < noteDur {
                    let env = exp(-5.0 * dt)
                    var w = sin(2 * .pi * freq * dt) + 0.3 * sin(2 * .pi * 2 * freq * dt)
                    if shimmer { w += 0.2 * sin(2 * .pi * 3 * freq * dt) }
                    s += w * env
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
