import AVFoundation

// Soft ambient "thinking" sound: a warm low note that pulses slowly with an
// echo tail — a gentle "loading" feel. Output-only (no permission). Plays
// until the process is killed.
func runHum(_ args: [String]) -> Never {
    var volume: Float = 0.22
    var interval: Double = 2.4 // seconds between pulses
    var i = 0
    while i < args.count {
        switch args[i] {
        case "--volume": i += 1; if i < args.count { volume = Float(args[i]) ?? volume }
        case "--interval": i += 1; if i < args.count { interval = Double(args[i]) ?? interval }
        default: break
        }
        i += 1
    }

    let engine = AVAudioEngine()
    let output = engine.outputNode
    let format = output.inputFormat(forBus: 0)
    let sr = format.sampleRate > 0 ? format.sampleRate : 48000

    let freq = 130.81 // C3 — warm and low
    let intervalSamples = max(1, Int(interval * sr))
    let decay = 2.2   // slow decay -> long tail
    let noteDur = 1.8 // seconds a note may ring
    let attack = 0.02 // gentle attack (not a sharp mallet)

    // Feedback delay line for the echo.
    let delaySamples = max(1, Int(0.33 * sr))
    var delay = [Float](repeating: 0, count: delaySamples)
    var delayIdx = 0
    let feedback: Float = 0.5

    var n = 0
    var noteStart = 0

    let source = AVAudioSourceNode { _, _, frameCount, abl in
        let buffers = UnsafeMutableAudioBufferListPointer(abl)
        for frame in 0..<Int(frameCount) {
            if n % intervalSamples == 0 { noteStart = n }
            let t = Double(n - noteStart) / sr
            var dry: Double = 0
            if t < noteDur {
                var env = exp(-decay * t)
                if t < attack { env *= t / attack }
                let w = sin(2 * .pi * freq * t) + 0.4 * sin(2 * .pi * 2 * freq * t)
                dry = w * env
            }
            // Echo: out = dry + delayed; recirculate with feedback.
            let echoed = delay[delayIdx]
            let out = Float(dry) + echoed
            delay[delayIdx] = Float(dry) + echoed * feedback
            delayIdx = (delayIdx + 1) % delaySamples

            let sample = out * volume
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
        fail("hum engine failed to start: \(error.localizedDescription)")
    }

    CFRunLoopRun() // until killed
    exit(0)
}
