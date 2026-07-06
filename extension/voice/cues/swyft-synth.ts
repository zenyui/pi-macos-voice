// Optional macOS cues via live swyft synthesis (`swyft hum` / `swyft chime`).
// Kept for mac because the Swift engine can vary volume/pitch live; the default
// cues provider is the cross-platform baked-WAV one (cues/wav.ts).

import type { CueHandle, CuesProvider, CueStyle } from "../protocol";
import { binariesExist, chime, hum } from "../native/mac";

export const swyftSynthCues: CuesProvider = {
	id: "swyft-synth",
	label: "swyft live synth",
	supports: ["darwin"],
	needsBinary: true,
	readiness() {
		return binariesExist()
			? { available: true }
			: { available: false, reason: "swyft binary/app missing — run `npm run build`." };
	},
	hum(volume?: number): CueHandle {
		return hum(volume);
	},
	chime(style: CueStyle = "bloop"): void {
		chime(style);
	},
};
