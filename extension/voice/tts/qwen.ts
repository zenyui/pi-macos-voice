// On-device Qwen3-TTS, wrapping `swyft tts --engine qwen` (macOS). The model
// lives inside the swyft binary today (Swift TTSKit); this is the thin wrapper.
// `voiceId` is a Qwen3 speaker id (ryan, aiden, serena, …), not an AVSpeech voice.

import type { SpeakHandle, SpeakOptions, TtsProvider } from "../protocol";
import { binariesExist, speak } from "../native/mac";

export const DEFAULT_QWEN_VOICE = "aiden";

export const qwenTts: TtsProvider = {
	id: "qwen",
	label: "Qwen3-TTS (on-device)",
	supports: ["darwin"],
	needsBinary: true,
	readiness() {
		return binariesExist()
			? { available: true }
			: { available: false, reason: "swyft binary/app missing — run `npm run build`." };
	},
	speak(text: string, opts: SpeakOptions = {}): SpeakHandle {
		return speak(text, { engine: "qwen", voiceId: opts.voiceId || DEFAULT_QWEN_VOICE });
	},
};
