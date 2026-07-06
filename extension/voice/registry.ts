// Provider registry: the one place that knows the full provider set. Filters to
// what runs on the current host, picks sensible defaults, and returns friendly
// errors when an unsupported / unknown provider is requested. The engine talks
// only to this module (plus the interfaces in protocol.ts) — never to a
// concrete provider file or the native layer directly.

import type { CuesProvider, Platform, SttProvider, TtsProvider } from "./protocol";
import { appleStt } from "./stt/apple";
import { whisperStt } from "./stt/whisper";
import { systemTts } from "./tts/system";
import { qwenTts } from "./tts/qwen";
import { wavCues } from "./cues/wav";
import { swyftSynthCues } from "./cues/swyft-synth";

const HOST: Platform = process.platform;

// Registered providers, in preference order (first supported = default).
const STT: SttProvider[] = [whisperStt, appleStt];
const TTS: TtsProvider[] = [systemTts, qwenTts];
const CUES: CuesProvider[] = [wavCues, swyftSynthCues];

interface HasSupport {
	readonly id: string;
	readonly label: string;
	readonly supports: readonly Platform[];
}

const supportedOn = <T extends HasSupport>(list: T[], host = HOST): T[] =>
	list.filter((p) => p.supports.includes(host));

/** Resolve a provider by id, or a friendly Error explaining why it can't run. */
function resolve<T extends HasSupport>(list: T[], id: string, kind: string, host = HOST): T | Error {
	const found = list.find((p) => p.id === id);
	if (!found) {
		const ids = list.map((p) => p.id).join(", ");
		return new Error(`unknown ${kind} provider "${id}" (known: ${ids})`);
	}
	if (!found.supports.includes(host)) {
		const alt = supportedOn(list, host).map((p) => p.id);
		const hint = alt.length ? ` Try: ${alt.join(", ")}.` : "";
		return new Error(`${kind} provider "${id}" is not supported on ${host}.${hint}`);
	}
	return found;
}

/** First provider that supports the current host, or undefined if none do. */
const defaultOf = <T extends HasSupport>(list: T[], host = HOST): T | undefined =>
	supportedOn(list, host)[0];

export const registry = {
	host: HOST,
	stt: {
		list: () => supportedOn(STT),
		default: () => defaultOf(STT),
		get: (id: string) => resolve(STT, id, "STT"),
	},
	tts: {
		list: () => supportedOn(TTS),
		default: () => defaultOf(TTS),
		get: (id: string) => resolve(TTS, id, "TTS"),
	},
	cues: {
		list: () => supportedOn(CUES),
		default: () => defaultOf(CUES),
		get: (id: string) => resolve(CUES, id, "cues"),
	},
};

export function isError<T>(v: T | Error): v is Error {
	return v instanceof Error;
}
