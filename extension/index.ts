import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { toSpeakable } from "./speakable";
import { binariesExist, getVersion } from "./voice/native/mac";
import { registry, isError } from "./voice/registry";
import type { CueStyle, SpeakHandle, SttMessage, SttSession } from "./voice/protocol";
import { DEFAULT_WHISPER_MODEL } from "./voice/stt/whisper";
import { DEFAULT_QWEN_VOICE } from "./voice/tts/qwen";

// Persisted engine preferences (STT + TTS). Each TTS provider has its own
// built-in default voice; there is no per-voice picker. Lives outside the repo
// so it survives rebuilds.
const CONFIG_PATH = join(homedir(), CONFIG_DIR_NAME, "agent", "pivoice.json");
// Bump when the on-disk shape changes incompatibly; loadConfig ignores configs
// with a newer/unknown version so an old build won't misread a future format.
const CONFIG_VERSION = 1;
// STT engine: "whisper" (local WhisperKit / Core ML, default) or "apple"
// (native SFSpeechRecognizer). Persisted so the choice survives restarts.
type SttEngine = "apple" | "whisper";
// Read-aloud engine: "auto" (system default, best of av/say), or an explicit
// backend. "qwen" runs on-device Qwen3-TTS via WhisperKit's TTSKit.
type TtsEngine = "auto" | "av" | "say" | "qwen";
interface VoiceConfig {
	sttEngine: SttEngine;
	whisperModel: string;
	ttsEngine: TtsEngine;
	// Qwen3 speaker id (e.g. ryan, serena) used when ttsEngine === "qwen".
	qwenVoice: string;
}
function loadConfig(): VoiceConfig {
	try {
		const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
		if (typeof cfg.version === "number" && cfg.version > CONFIG_VERSION) throw 0;
		const tts: TtsEngine =
			cfg.ttsEngine === "av" || cfg.ttsEngine === "say" || cfg.ttsEngine === "qwen"
				? cfg.ttsEngine
				: "av";
		return {
			sttEngine: cfg.sttEngine === "apple" ? "apple" : "whisper",
			whisperModel: cfg.whisperModel || DEFAULT_WHISPER_MODEL,
			ttsEngine: tts,
			qwenVoice: cfg.qwenVoice || DEFAULT_QWEN_VOICE,
		};
	} catch {
		return {
			sttEngine: "whisper",
			whisperModel: DEFAULT_WHISPER_MODEL,
			ttsEngine: "av",
			qwenVoice: DEFAULT_QWEN_VOICE,
		};
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
					sttEngine: cfg.sttEngine,
					whisperModel: cfg.whisperModel,
					ttsEngine: cfg.ttsEngine,
					qwenVoice: cfg.qwenVoice,
				},
				null,
				2,
			),
		);
	} catch {}
}

// Version the extension expects the picrophone binary to match. Read from our own
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
	let sttEngine: SttEngine = config.sttEngine; // apple | whisper
	let whisperModel: string = config.whisperModel;
	let ttsEngine: TtsEngine = config.ttsEngine; // auto | av | say | qwen
	let qwenVoice: string = config.qwenVoice; // Qwen3 speaker id
	const persist = () => saveConfig({ sttEngine, whisperModel, ttsEngine, qwenVoice });
	let micMuted = false; // user paused dictation via voice ("mute"); only unmute is heard
	const voiceOn = () => state !== "off";

	// Cues provider (default: cross-platform baked WAVs). Resolved once; may be
	// undefined on an unsupported host, so every call site is null-guarded.
	const cues = registry.cues.default();
	const playChime = (style?: CueStyle) => cues?.chime(style);

	// Resolve the TTS provider + speak options for the current engine setting.
	// "qwen" -> qwen provider (Qwen3 speaker id); everything else -> system
	// provider with the engine hint ("auto" | "av" | "say").
	function speakNow(text: string, ctx: ExtensionContext): SpeakHandle | null {
		const id = ttsEngine === "qwen" ? "qwen" : "system";
		const prov = registry.tts.get(id);
		if (isError(prov)) {
			ctx.ui.notify(`picrophone: ${prov.message}`, "error");
			return null;
		}
		return ttsEngine === "qwen"
			? prov.speak(text, { voiceId: qwenVoice })
			: prov.speak(text, { engine: ttsEngine });
	}

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

	function engineInfo(): string {
		return `(tts: ${ttsEngine}, stt: ${sttEngine})`;
	}

	function statusFor(): string {
		let base: string;
		switch (state) {
			case "off": return "";
			case "thinking": base = "🎙 thinking"; break;
			case "speaking": base = "🎙 speaking"; break;
			default: base = micMuted ? "🔇 muted" : "🎙 on"; break;
		}
		return `${base} ${engineInfo()}`;
	}

	function setState(next: VoiceState, ctx: ExtensionContext) {
		const prev = state;
		state = next;
		ctx.ui.setStatus("picrophone", statusFor());
		// Play a short earcon when we hand the turn back to the user (finished
		// thinking/speaking). Fires within the TTS mute tail, so it isn't
		// re-transcribed as input.
		if (next === "listening" && (prev === "thinking" || prev === "speaking")) playChime();
	}

	function stopHum() {
		humming?.kill();
		humming = null;
	}

	// Voice mute/unmute: pause or resume dictation without leaving voice mode.
	function setMicMuted(on: boolean, ctx: ExtensionContext) {
		if (micMuted === on) return;
		micMuted = on;
		ctx.ui.setWidget("picrophone", []);
		ctx.ui.setStatus("picrophone", statusFor());
		ctx.ui.notify(on ? 'Mic muted — say "unmute" to resume.' : "Mic live.", "info");
		playChime(on ? "down" : "bloop");
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
		// For Qwen, --voice selects a Qwen3 speaker; the system engines (av/say)
		// use their own built-in default voice.
		const s = speakNow(next, ctx);
		if (!s) {
			// Provider unavailable: skip this item, keep draining the queue.
			if (state === "speaking" && speakQueue.length === 0) setState("listening", ctx);
			else drainSpeak(ctx);
			return;
		}
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
		ctx.ui.setWidget("picrophone", []);
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
				ctx.ui.setWidget("picrophone", [`🎙 ${msg.text}`]);
				break;
			}
			case "final": {
				ctx.ui.setWidget("picrophone", []);
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
					`picrophone: mic=${msg.mic}, speech=${msg.speech}. Grant access to Picrophone in System Settings → Privacy.`,
					"error",
				);
				void stopVoice(ctx);
				break;
			case "warn":
				ctx.ui.notify(`picrophone: ${msg.message}`, "warning");
				break;
			case "progress":
				// Model download/compile status (whisper first run). Show it live in
				// the footer rather than as stacked notifications.
				ctx.ui.setStatus("picrophone", `🎙 ${msg.message}`);
				break;
		}
	}

	async function startVoice(ctx: ExtensionContext) {
		if (!ready || voiceOn()) return;
		setState("listening", ctx);
		ctx.ui.setStatus("picrophone", "🎙 starting…");
		if (sttEngine === "whisper") {
			ctx.ui.notify(
				`Voice STT: whisper (${whisperModel}). First run downloads the model ` +
					"(~150 MB for base.en) to ~/Library/Caches/picrophone — one time, " +
					"then cached. Progress shows in the footer.",
				"info",
			);
		}
		const prov = registry.stt.get(sttEngine);
		if (isError(prov)) {
			ctx.ui.notify(`picrophone: ${prov.message}`, "error");
			setState("off", ctx);
			return;
		}
		stt = prov.start((msg: SttMessage) => handleStt(msg, ctx), {
			silenceMs: 1200,
			model: sttEngine === "whisper" ? whisperModel : undefined,
		});
	}

	async function stopVoice(ctx: ExtensionContext) {
		stt?.stop();
		stt = null;
		micMuted = false;
		stopHum();
		clearSpeakQueue();
		ctx.ui.setWidget("picrophone", []);
		setState("off", ctx);
	}

	pi.on("session_start", async (_event, ctx) => {
		if (!binariesExist()) {
			ctx.ui.notify("picrophone binary/app missing — run `npm run build && npm run build:app`.", "warning");
			return;
		}
		try {
			const v = await getVersion();
			if (v.version !== EXPECTED_VERSION) {
				ctx.ui.notify(
					`picrophone version ${v.version} != extension ${EXPECTED_VERSION}; rebuild (npm run build).`,
					"warning",
				);
				return;
			}
			ready = true;
		} catch {
			ctx.ui.notify("picrophone: failed to read version; rebuild the binary.", "warning");
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
		if (!humming) humming = cues?.hum() ?? null;
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
				ctx.ui.notify("picrophone not ready — build the binary first.", "warning");
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

	// Toggle mic mute without leaving voice mode (same effect as saying
	// "mute"/"unmute"). No-op unless voice mode is on.
	pi.registerCommand("mute", {
		description: "Mute/unmute voice dictation without leaving voice mode.",
		handler: async (_args, ctx) => {
			if (!voiceOn()) {
				ctx.ui.notify("Voice mode is off — run /voice first.", "info");
				return;
			}
			setMicMuted(!micMuted, ctx);
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
					content: [{ type: "text", text: "picrophone not ready — build it first (npm run build && npm run build:app)." }],
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

	// LLM-callable config setter. Kept deliberately small: a single freeform
	// `settings` object, no per-field schema. Called with no settings it returns
	// the current config plus valid values, so the model discovers the shape on
	// demand instead of paying for a verbose schema every turn. Validation lives
	// here, not in the JSON schema.
	const STT_ENGINES = ["apple", "whisper"] as const;
	const TTS_ENGINES = ["auto", "av", "say", "qwen"] as const;
	const QWEN_SPEAKERS = [
		"ryan", "aiden", "serena", "vivian", "eric", "dylan", "sohee", "ono-anna", "uncle-fu",
	] as const;
	function configSnapshot() {
		return { sttEngine, whisperModel, ttsEngine, qwenVoice };
	}
	pi.registerTool({
		name: "voice_config",
		label: "Voice Config",
		description:
			"Get or set picrophone voice settings. Call with no settings to read the " +
			"current config and the valid values for each field, then call again with " +
			"the fields you want to change.",
		promptSnippet: "Read or change voice STT/TTS settings (call empty first to see valid values)",
		parameters: Type.Object({
			settings: Type.Optional(
				Type.Record(Type.String(), Type.String(), {
					description: "Fields to change: sttEngine, whisperModel, ttsEngine, qwenVoice.",
				}),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const s = params.settings ?? {};
			const keys = Object.keys(s);
			if (keys.length === 0) {
				return {
					content: [{
						type: "text",
						text: JSON.stringify({
							current: configSnapshot(),
							valid: {
								sttEngine: STT_ENGINES,
								ttsEngine: TTS_ENGINES,
								qwenVoice: QWEN_SPEAKERS,
								whisperModel: "any whisper model, e.g. tiny.en, base.en, small.en, large-v3-turbo",
							},
						}, null, 2),
					}],
					details: { ok: true, config: configSnapshot() },
				};
			}
			const errors: string[] = [];
			for (const k of keys) {
				const v = String(s[k]);
				switch (k) {
					case "sttEngine":
						if ((STT_ENGINES as readonly string[]).includes(v)) sttEngine = v as SttEngine;
						else errors.push(`sttEngine must be one of ${STT_ENGINES.join(", ")}`);
						break;
					case "ttsEngine":
						if ((TTS_ENGINES as readonly string[]).includes(v)) ttsEngine = v as TtsEngine;
						else errors.push(`ttsEngine must be one of ${TTS_ENGINES.join(", ")}`);
						break;
					case "whisperModel":
						whisperModel = v;
						break;
					case "qwenVoice":
						qwenVoice = v.toLowerCase();
						break;
					default:
						errors.push(`unknown field "${k}"`);
				}
			}
			if (errors.length) {
				return { content: [{ type: "text", text: `Rejected: ${errors.join("; ")}` }], details: { ok: false } };
			}
			persist();
			ctx.ui.setStatus("picrophone", statusFor());
			const note = voiceOn() ? " Restart voice mode (/voice off, then on) to apply STT changes." : "";
			return {
				content: [{ type: "text", text: `Updated. Config is now ${JSON.stringify(configSnapshot())}.${note}` }],
				details: { ok: true, config: configSnapshot() },
			};
		},
	});

	// Switch the STT engine (persisted). `whisper` runs locally via WhisperKit;
	// `apple` uses the native SFSpeechRecognizer. Takes effect next time voice
	// mode starts. Optional second arg sets the whisper model.
	pi.registerCommand("voice-stt", {
		description: "Set the STT engine: apple (native) or whisper (local). Optional: whisper model name.",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const want = (parts[0] || "").toLowerCase();
			if (want !== "apple" && want !== "whisper") {
				ctx.ui.notify(
					`STT engine: ${sttEngine}${sttEngine === "whisper" ? ` (${whisperModel})` : ""}. ` +
						"Usage: /voice-stt apple | whisper [model]",
					"info",
				);
				return;
			}
			sttEngine = want;
			if (want === "whisper" && parts[1]) whisperModel = parts[1];
			persist();
			const label = want === "whisper" ? `whisper (${whisperModel})` : "apple (native)";
			const note = voiceOn() ? " Restart voice mode (/voice off, then on) to apply." : "";
			ctx.ui.notify(`STT engine set to ${label}.${note}`, "info");
		},
	});

	// Switch the TTS (read-aloud) engine (persisted, takes effect immediately).
	// `qwen` runs on-device Qwen3-TTS; pass a Qwen3 speaker id as a second arg
	// (ryan, aiden, serena, vivian, eric, dylan, sohee, ono-anna, uncle-fu).
	pi.registerCommand("voice-tts", {
		description: "Set the read-aloud engine: auto | av | say | qwen [speaker].",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const want = (parts[0] || "").toLowerCase();
			if (want !== "auto" && want !== "av" && want !== "say" && want !== "qwen") {
				const cur = ttsEngine === "qwen" ? `qwen (${qwenVoice})` : ttsEngine;
				ctx.ui.notify(
					`TTS engine: ${cur}. Usage: /voice-tts auto | av | say | qwen [speaker]`,
					"info",
				);
				return;
			}
			ttsEngine = want;
			if (want === "qwen" && parts[1]) qwenVoice = parts[1].toLowerCase();
			persist();
			const label = want === "qwen" ? `qwen (${qwenVoice})` : want;
			ctx.ui.notify(`TTS engine set to ${label}.`, "info");
		},
	});
}
