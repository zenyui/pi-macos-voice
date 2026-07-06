// Apple SFSpeechRecognizer STT, wrapping `picrophone stt --engine apple` (macOS).

import type { SttMessage, SttOptions, SttProvider, SttSession } from "../protocol";
import { binariesExist, startStt } from "../native/mac";

export const appleStt: SttProvider = {
	id: "apple",
	label: "Apple (SFSpeechRecognizer)",
	supports: ["darwin"],
	needsBinary: true,
	readiness() {
		return binariesExist()
			? { available: true }
			: { available: false, reason: "picrophone binary/app missing — run `npm run build`." };
	},
	start(onMessage: (msg: SttMessage) => void, opts: SttOptions = {}): SttSession {
		return startStt(onMessage, { ...opts, engine: "apple" });
	},
};
