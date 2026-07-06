// Optional macOS cues via live native synthesis (`picrophone hum` / `picrophone chime`).
// Kept for mac because the native engine can vary volume/pitch live; the default
// cues provider is the cross-platform baked-WAV one (cues/wav.ts).

import type { CueHandle, CuesProvider, CueStyle } from "../protocol";
import { binariesExist, chime, hum } from "../native/mac";

export const synthCues: CuesProvider = {
	id: "synth",
	label: "Native synth",
	supports: ["darwin"],
	needsBinary: true,
	readiness() {
		return binariesExist()
			? { available: true }
			: { available: false, reason: "picrophone binary/app missing — run `npm run build`." };
	},
	hum(volume?: number): CueHandle {
		return hum(volume);
	},
	chime(style: CueStyle = "bloop"): void {
		chime(style);
	},
};
