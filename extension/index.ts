import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { toSpeakable } from "./speakable";
import {
	binariesExist,
	chime,
	getVersion,
	getVoices,
	hum,
	speak,
	startStt,
	type SttMessage,
	type SttSession,
	type Voice,
} from "./swyft";

// Persisted voice preference. When set, we pass it to swyft's TTS instead of
// letting the binary auto-pick (which prefers en-US and ignores the system
// voice). Lives outside the repo so it survives rebuilds.
const CONFIG_PATH = join(homedir(), CONFIG_DIR_NAME, "agent", "pivoice.json");
// Bump when the on-disk shape changes incompatibly; loadConfig ignores configs
// with a newer/unknown version so an old build won't misread a future format.
const CONFIG_VERSION = 1;
// STT engine: "whisper" (local WhisperKit / Core ML, default) or "apple"
// (native SFSpeechRecognizer). Persisted so the choice survives restarts.
type SttEngine = "apple" | "whisper";
const DEFAULT_WHISPER_MODEL = "base.en";
interface VoiceConfig {
	voiceId?: string;
	sttEngine: SttEngine;
	whisperModel: string;
}
function loadConfig(): VoiceConfig {
	try {
		const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
		if (typeof cfg.version === "number" && cfg.version > CONFIG_VERSION) throw 0;
		return {
			voiceId: cfg.voiceId || undefined,
			sttEngine: cfg.sttEngine === "apple" ? "apple" : "whisper",
			whisperModel: cfg.whisperModel || DEFAULT_WHISPER_MODEL,
		};
	} catch {
		return { voiceId: undefined, sttEngine: "whisper", whisperModel: DEFAULT_WHISPER_MODEL };
	}
}
function saveConfig(cfg: VoiceConfig): void {
	try {
		mkdirSync(dirname(CONFIG_PATH), { recursive: true });
		writeFileSync(
			CONFIG_PATH,
			JSON.stringify(
				{
					version: CONFIG_VERSION,
					voiceId: cfg.voiceId ?? null,
					sttEngine: cfg.sttEngine,
					whisperModel: cfg.whisperModel,
				},
				null,
				2,
			),
		);
	} catch {}
}

// Version the extension expects the swyft binary to match. Read from our own
// package.json (the single source of truth) so it can never drift from the
// binary, which gen-version stamps from the same file.
const EXPECTED_VERSION: string = JSON.parse(
	readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
).version;

const VOICE_MODE_PROMPT = [
	"You are in VOICE MODE. Your replies are READ ALOUD, so brevity is critical.",
	"Hard rules:",
	"(1) Answer in at most 2-3 short sentences — aim for under ~40 words — unless",
	"the user explicitly asks for detail, a list, or a walkthrough.",
	"(2) Lead with the answer or the action. No preamble, no recap of the question,",
	"no 'Sure, I can help with that.'",
	"(3) Never read code, file paths, diffs, tables, or bullet lists aloud. If you",
	"wrote or changed code, just say what you did in one sentence and stop.",
	"(4) If the honest answer is long, give a one-sentence summary and offer to",
	"expand ('want the details?') rather than dumping everything.",
	"(5) Sound conversational, like spoken English, not written documentation.",
	"Messages prefixed with 🎙 were dictated by the user via speech-to-text: treat",
	"them as raw transcripts that may contain homophones, missing punctuation, or",
	"recognition errors. Infer intent and don't nitpick wording.",
].join(" ");

// Prefix on auto-sent transcripts so the model (and user) can tell it was spoken.
const MIC_PREFIX = "🎙 ";

// Spoken interrupt words. Two match modes:
// - strict (normal listening): the WHOLE utterance must be a stop word, so
//   "stop the server" is a real request, not an interrupt.
// - loose (while we're speaking): a stop word appearing ANYWHERE triggers,
//   because the mic hears our TTS mixed with the user, so the transcript is
//   garbled (e.g. "pop stop") and never matches exactly.
const STOP_WORDS = new Set([
	"stop", "stop stop", "cancel", "nevermind", "never mind", "wait", "shut up", "shutup",
]);
const STOP_PATTERN = /\b(stop|cancel|wait|shut\s*up|never\s*mind)\b/i;
function isStopWord(text: string): boolean {
	const t = text.trim().toLowerCase().replace(/[.!?,]+$/, "").trim();
	return STOP_WORDS.has(t);
}
function containsStopWord(text: string): boolean {
	return STOP_PATTERN.test(text);
}

// Voice mute: pause/resume dictation without leaving voice mode.
// - mute: strict whole-utterance match (so "mute the audio" isn't a mute).
// - unmute: loose match anywhere (easy to turn back on even with a noisy
//   transcript, since while muted the only thing we listen for is unmute).
const MUTE_WORDS = new Set(["mute", "pause", "hush"]);
const UNMUTE_PATTERN = /\b(unmute|resume|wake up|listen up|start listening)\b/i;
function isMuteWord(text: string): boolean {
	const t = text.trim().toLowerCase().replace(/[.!?,]+$/, "").trim();
	return MUTE_WORDS.has(t);
}
function isUnmuteWord(text: string): boolean {
	return UNMUTE_PATTERN.test(text);
}

export default function (pi: ExtensionAPI) {
	// Voice mode is a small state machine driven entirely by events (pi lifecycle
	// + STT messages) — no polling loop, per pi extension best practice.
	type VoiceState = "off" | "listening" | "thinking" | "speaking";
	let state: VoiceState = "off";
	let stt: SttSession | null = null;
	let ready = false; // binary present + version ok
	const config = loadConfig();
	let voiceId: string | undefined = config.voiceId; // chosen TTS voice, if any
	let sttEngine: SttEngine = config.sttEngine; // apple | whisper
	let whisperModel: string = config.whisperModel;
	let micMuted = false; // user paused dictation via voice ("mute"); only unmute is heard
	const voiceOn = () => state !== "off";

	// TTS + speak queue.
	let speaking: { kill: () => void } | null = null;
	let speakGen = 0; // guards the post-playback echo-flush timer
	const speakQueue: string[] = [];
	// While reading aloud (plus a short tail) the mic hears our own TTS, so we
	// suppress input except the stop word to avoid a self-talk feedback loop.
	let suppressInputUntil = 0;
	const TTS_TAIL_MS = 700;

	// Hum (thinking sound).
	let humming: { kill: () => void } | null = null;

	function statusFor(): string {
		switch (state) {
			case "off": return "";
			case "thinking": return "🎙 thinking";
			case "speaking": return "🎙 speaking";
			default: return micMuted ? "🔇 muted" : "🎙 on";
		}
	}

	function setState(next: VoiceState, ctx: ExtensionContext) {
		const prev = state;
		state = next;
		ctx.ui.setStatus("swyft", statusFor());
		// Play a short earcon when we hand the turn back to the user (finished
		// thinking/speaking). Fires within the TTS mute tail, so it isn't
		// re-transcribed as input.
		if (next === "listening" && (prev === "thinking" || prev === "speaking")) chime();
	}

	function stopHum() {
		humming?.kill();
		humming = null;
	}

	// Voice mute/unmute: pause or resume dictation without leaving voice mode.
	function setMicMuted(on: boolean, ctx: ExtensionContext) {
		if (micMuted === on) return;
		micMuted = on;
		ctx.ui.setWidget("swyft", []);
		ctx.ui.setStatus("swyft", statusFor());
		ctx.ui.notify(on ? 'Mic muted — say "unmute" to resume.' : "Mic live.", "info");
		chime(on ? "down" : "bloop");
	}

	// --- Speak queue: items play to completion in order (no overlap). ------
	function enqueueSpeak(text: string, ctx: ExtensionContext) {
		const spoken = toSpeakable(text);
		if (!spoken) return;
		speakQueue.push(spoken);
		if (!speaking) drainSpeak(ctx);
	}

	function drainSpeak(ctx: ExtensionContext) {
		const next = speakQueue.shift();
		if (next === undefined) {
			if (state === "speaking") setState("listening", ctx);
			return;
		}
		if (state !== "speaking") setState("speaking", ctx);
		const s = speak(next, { voiceId });
		speaking = s;
		void s.done.then(() => {
			if (speaking === s) {
				speaking = null;
				suppressInputUntil = Date.now() + TTS_TAIL_MS;
				// Flush any of our own TTS the mic picked up during playback so it
				// never finalizes into a spurious message. Wait out the echo tail
				// first so trailing audio is discarded too.
				if (speakQueue.length === 0) {
					const gen = ++speakGen;
					setTimeout(() => {
						if (gen === speakGen && !speaking) stt?.reset();
					}, TTS_TAIL_MS);
				}
			}
			drainSpeak(ctx);
		});
	}

	// Flush queued + active readback (stop word, new turn, voice off).
	function clearSpeakQueue() {
		speakQueue.length = 0;
		speaking?.kill();
		speaking = null;
		suppressInputUntil = Date.now() + TTS_TAIL_MS;
		// Flush echo captured during playback, after the tail passes.
		const gen = ++speakGen;
		setTimeout(() => {
			if (gen === speakGen && !speaking) stt?.reset();
		}, TTS_TAIL_MS);
	}

	// True while our own TTS is (or just was) playing — mic input is our echo.
	function inputMuted(): boolean {
		return speaking !== null || Date.now() < suppressInputUntil;
	}

	// Spoken "stop": flush readback, stop hum, abort the turn (like Esc).
	function handleStop(ctx: ExtensionContext) {
		clearSpeakQueue();
		stopHum();
		if (!ctx.isIdle()) ctx.abort();
		ctx.ui.setWidget("swyft", []);
		if (state !== "off") setState("listening", ctx);
	}

	function handleStt(msg: SttMessage, ctx: ExtensionContext) {
		switch (msg.type) {
			case "ready":
				if (state !== "thinking" && state !== "speaking") setState("listening", ctx);
				break;
			case "partial": {
				// While muted, ignore partials entirely. Unmute is handled on the
				// final only, so the unmute utterance isn't sent after resuming.
				if (micMuted) break;
				const muted = inputMuted();
				if (muted ? containsStopWord(msg.text) : isStopWord(msg.text)) {
					handleStop(ctx);
					break;
				}
				if (muted) break; // ignore our own TTS echo; only a stop word is heard
				ctx.ui.setWidget("swyft", [`🎙 ${msg.text}`]);
				break;
			}
			case "final": {
				ctx.ui.setWidget("swyft", []);
				const text = msg.text.trim();
				if (!text) break;
				// Unmute is always allowed (even while muted), final-only.
				if (micMuted) {
					if (isUnmuteWord(text)) setMicMuted(false, ctx);
					break; // muted: ignore everything except "unmute"
				}
				const muted = inputMuted();
				// Stop/barge-in works even during our own speech (loose match).
				if (muted ? containsStopWord(text) : isStopWord(text)) {
					handleStop(ctx);
					break;
				}
				if (muted) break; // our own TTS echo — never mute or send from it
				// Real user speech from here on.
				if (isMuteWord(text)) {
					setMicMuted(true, ctx);
					break;
				}
				pi.sendUserMessage(`${MIC_PREFIX}${text}`);
				break;
			}
			case "permission":
				ctx.ui.notify(
					`swyft: mic=${msg.mic}, speech=${msg.speech}. Grant access to Swyft in System Settings → Privacy.`,
					"error",
				);
				void stopVoice(ctx);
				break;
			case "warn":
				ctx.ui.notify(`swyft: ${msg.message}`, "warning");
				break;
			case "progress":
				// Model download/compile status (whisper first run). Show it live in
				// the footer rather than as stacked notifications.
				ctx.ui.setStatus("swyft", `🎙 ${msg.message}`);
				break;
		}
	}

	async function startVoice(ctx: ExtensionContext) {
		if (!ready || voiceOn()) return;
		setState("listening", ctx);
		ctx.ui.setStatus("swyft", "🎙 starting…");
		if (sttEngine === "whisper") {
			ctx.ui.notify(
				`Voice STT: whisper (${whisperModel}). First run downloads the model ` +
					"(~150 MB for base.en) to ~/Library/Caches/pi-macos-voice — one time, " +
					"then cached. Progress shows in the footer.",
				"info",
			);
		}
		stt = startStt((msg) => handleStt(msg, ctx), {
			silenceMs: 1200,
			engine: sttEngine,
			model: sttEngine === "whisper" ? whisperModel : undefined,
		});
	}

	async function stopVoice(ctx: ExtensionContext) {
		stt?.stop();
		stt = null;
		micMuted = false;
		stopHum();
		clearSpeakQueue();
		ctx.ui.setWidget("swyft", []);
		setState("off", ctx);
	}

	pi.on("session_start", async (_event, ctx) => {
		if (!binariesExist()) {
			ctx.ui.notify("swyft binary/app missing — run `npm run build && npm run build:app`.", "warning");
			return;
		}
		try {
			const v = await getVersion();
			if (v.version !== EXPECTED_VERSION) {
				ctx.ui.notify(
					`swyft version ${v.version} != extension ${EXPECTED_VERSION}; rebuild (npm run build).`,
					"warning",
				);
				return;
			}
			ready = true;
		} catch {
			ctx.ui.notify("swyft: failed to read version; rebuild the binary.", "warning");
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		await stopVoice(ctx);
	});

	pi.on("before_agent_start", async (event) => {
		if (!voiceOn()) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${VOICE_MODE_PROMPT}` };
	});

	pi.on("agent_start", async (_event, ctx) => {
		if (!voiceOn()) return;
		clearSpeakQueue(); // new turn: drop any leftover readback
		setState("thinking", ctx);
		if (!humming) humming = hum();
	});

	pi.on("agent_end", async (event, ctx) => {
		stopHum(); // done thinking
		if (!voiceOn()) return;
		// Speak the final assistant text of this prompt (queued, never overlapping).
		const assistant = [...event.messages].reverse().find((m) => m.role === "assistant");
		if (assistant) {
			const text = assistant.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");
			enqueueSpeak(text, ctx);
		}
		if (state === "thinking") setState("listening", ctx); // nothing to speak
	});

	pi.registerCommand("voice", {
		description: "Toggle voice mode on/off (speak, sends on pause).",
		handler: async (_args, ctx) => {
			if (!ready) {
				ctx.ui.notify("swyft not ready — build the binary first.", "warning");
				return;
			}
			if (!voiceOn()) {
				await startVoice(ctx);
				ctx.ui.notify("Voice on — speak, sends on pause.", "info");
			} else {
				await stopVoice(ctx);
				ctx.ui.notify("Voice mode off.", "info");
			}
		},
	});

	// Match a free-text name (e.g. "Zoe", "Zoe enhanced", "en-GB premium") to an
	// installed voice. Prefers higher quality on ties.
	function matchVoice(query: string, voices: Voice[]): Voice | undefined {
		const q = query.trim().toLowerCase();
		if (!q) return undefined;
		const qual = { premium: 2, enhanced: 1, default: 0 } as const;
		const byQuality = (a: Voice, b: Voice) => qual[b.quality] - qual[a.quality];
		const scored = voices
			.map((v) => {
				const hay = `${v.name} ${v.language} ${v.quality}`.toLowerCase();
				const terms = q.split(/\s+/);
				const hits = terms.filter((t) => hay.includes(t)).length;
				return { v, hits };
			})
			.filter((s) => s.hits > 0)
			.sort((a, b) => b.hits - a.hits || byQuality(a.v, b.v));
		return scored[0]?.v;
	}

	pi.registerCommand("voices", {
		description: "List installed TTS voices (and the one swyft is using).",
		handler: async (_args, ctx) => {
			if (!ready) {
				ctx.ui.notify("swyft not ready — build the binary first.", "warning");
				return;
			}
			const voices = await getVoices();
			const en = voices.filter((v) => v.language.startsWith("en"));
			const lines = (en.length ? en : voices)
				.sort((a, b) => a.name.localeCompare(b.name))
				.map((v) => `${v.id === voiceId ? "● " : "  "}${v.name} (${v.language}, ${v.quality})`);
			const current = voiceId
				? voices.find((v) => v.id === voiceId)?.name ?? voiceId
				: "auto (best available)";
			ctx.ui.notify(`Current voice: ${current}\n${lines.join("\n")}`, "info");
		},
	});

	// LLM-callable: lets the agent turn voice mode on/off when the user asks.
	pi.registerTool({
		name: "voice_mode",
		label: "Voice Mode",
		description:
			"Turn native macOS voice mode on or off. When on, the user's speech is " +
			"transcribed into prompts and the agent's replies are read aloud.",
		promptSnippet: "Enable/disable spoken voice mode (mic dictation + read-aloud replies)",
		promptGuidelines: [
			"Call voice_mode when the user asks to turn voice/dictation/read-aloud on or off.",
		],
		parameters: Type.Object({
			action: StringEnum(["on", "off", "toggle"] as const),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!ready) {
				return {
					content: [{ type: "text", text: "swyft not ready — build it first (npm run build && npm run build:app)." }],
					details: { voiceOn: voiceOn() },
				};
			}
			const target = params.action === "toggle" ? !voiceOn() : params.action === "on";
			if (target && !voiceOn()) await startVoice(ctx);
			else if (!target && voiceOn()) await stopVoice(ctx);
			const label = voiceOn() ? "on" : "off";
			return { content: [{ type: "text", text: `Voice mode ${label}.` }], details: { voiceOn: voiceOn() } };
		},
	});

	// LLM-callable: change (or reset) the read-aloud voice on request.
	pi.registerTool({
		name: "set_voice",
		label: "Set Voice",
		description:
			"Change the voice used for read-aloud (TTS). Pass a voice name like " +
			"'Zoe', 'Zoe (Enhanced)', or 'en-GB premium'. Pass 'auto' to clear the " +
			"preference and let the system pick the best available voice. The choice " +
			"is persisted across sessions.",
		promptSnippet: "Change the read-aloud (TTS) voice",
		promptGuidelines: [
			"Call set_voice when the user asks to change, switch, or reset the " +
				"speaking/read-aloud voice (e.g. 'use Zoe', 'sound British', 'reset your voice').",
		],
		parameters: Type.Object({
			name: Type.String({ description: "Voice name/language query, or 'auto' to reset." }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!ready) {
				return { content: [{ type: "text", text: "swyft not ready — build it first." }], details: {} };
			}
			const q = params.name.trim();
			if (/^(auto|default|reset|system)$/i.test(q)) {
				voiceId = undefined;
				saveConfig({ voiceId, sttEngine, whisperModel });
				return { content: [{ type: "text", text: "Voice reset to auto (best available)." }], details: {} };
			}
			const voices = await getVoices();
			const match = matchVoice(q, voices);
			if (!match) {
				const names = [...new Set(voices.filter((v) => v.language.startsWith("en")).map((v) => v.name))];
				return {
					content: [{ type: "text", text: `No voice matched "${q}". Installed English voices: ${names.join(", ")}.` }],
					details: {},
				};
			}
			voiceId = match.id;
			saveConfig({ voiceId, sttEngine, whisperModel });
			return {
				content: [{ type: "text", text: `Voice set to ${match.name} (${match.language}, ${match.quality}).` }],
				details: { voiceId: match.id },
			};
		},
	});

	// Switch the STT engine (persisted). `whisper` runs locally via WhisperKit;
	// `apple` uses the native SFSpeechRecognizer. Takes effect next time voice
	// mode starts. Optional second arg sets the whisper model.
	pi.registerCommand("voice-engine", {
		description: "Set the STT engine: apple (native) or whisper (local). Optional: whisper model name.",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const want = (parts[0] || "").toLowerCase();
			if (want !== "apple" && want !== "whisper") {
				ctx.ui.notify(
					`STT engine: ${sttEngine}${sttEngine === "whisper" ? ` (${whisperModel})` : ""}. ` +
						"Usage: /voice-engine apple | whisper [model]",
					"info",
				);
				return;
			}
			sttEngine = want;
			if (want === "whisper" && parts[1]) whisperModel = parts[1];
			saveConfig({ voiceId, sttEngine, whisperModel });
			const label = want === "whisper" ? `whisper (${whisperModel})` : "apple (native)";
			const note = voiceOn() ? " Restart voice mode (/voice off, then on) to apply." : "";
			ctx.ui.notify(`STT engine set to ${label}.${note}`, "info");
		},
	});
}
