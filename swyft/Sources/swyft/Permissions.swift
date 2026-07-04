import AVFoundation
import Speech

func speechStatusString(_ status: SFSpeechRecognizerAuthorizationStatus) -> String {
    switch status {
    case .authorized: return "authorized"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "notDetermined"
    @unknown default: return "unknown"
    }
}

/// Request (or read) microphone authorization, returning a status string.
func requestMic(_ completion: @escaping (String) -> Void) {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: completion("authorized")
    case .denied: completion("denied")
    case .restricted: completion("restricted")
    case .notDetermined:
        AVCaptureDevice.requestAccess(for: .audio) { granted in
            completion(granted ? "authorized" : "denied")
        }
    @unknown default: completion("unknown")
    }
}

/// Request (or read) speech-recognition authorization, returning a status string.
func requestSpeech(_ completion: @escaping (String) -> Void) {
    let current = SFSpeechRecognizer.authorizationStatus()
    if current == .notDetermined {
        SFSpeechRecognizer.requestAuthorization { status in
            completion(speechStatusString(status))
        }
    } else {
        completion(speechStatusString(current))
    }
}
