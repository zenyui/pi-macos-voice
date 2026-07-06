// Local WhisperKit STT, wrapping `picrophone stt --engine whisper` (macOS).
// The whisper engine lives inside the picrophone binary today (Swift, not a TS
// wrapper); this file is only the thin interface conformance + default model.

import type { SttMessage, SttOptions, SttProvider, SttSession } from "../protocol";
import { binariesExist, startStt } from "../native/mac";

export const DEFAULT_WHISPER_MODEL = "base.en";

export const whisperStt: SttProvider = {
	id: "whisper",
	label: "Whisper (local WhisperKit)",
	supports: ["darwin"],
	needsBinary: true,
	readiness() {
		return binariesExist()
			? { available: true }
			: { available: false, reason: "picrophone binary/app missing — run `npm run build`." };
	},
	start(onMessage: (msg: SttMessage) => void, opts: SttOptions = {}): SttSession {
		return startStt(onMessage, {
			...opts,
			engine: "whisper",
			model: opts.model || DEFAULT_WHISPER_MODEL,
		});
	},
};
