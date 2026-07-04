import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { toSpeakable } from "./speakable";
import {
	binariesExist,
	chime,
	getVersion,
	hum,
	speak,
	startStt,
	type SttMessage,
	type SttSession,
} from "./swyft";

// Version the extension expects to match; kept equal to the repo VERSION file.
const EXPECTED_VERSION = "0.2.0";

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
	let autoSend = false; // false = push-to-send (fill prompt, you press Enter)
	let micMuted = false; // user paused dictation via voice ("mute"); only unmute is heard
	const voiceOn = () => state !== "off";

	// TTS + speak queue.
	let speaking: { kill: () => void } | null = null;
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
			default: return micMuted ? "🔇 muted" : autoSend ? "🎙 auto" : "🎙 push";
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
		const s = speak(next);
		speaking = s;
		void s.done.then(() => {
			if (speaking === s) {
				speaking = null;
				suppressInputUntil = Date.now() + TTS_TAIL_MS;
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
				if (micMuted) {
					if (isUnmuteWord(text)) setMicMuted(false, ctx);
					break; // muted: ignore everything except "unmute"
				}
				if (isMuteWord(text)) {
					setMicMuted(true, ctx);
					break;
				}
				const muted = inputMuted();
				if (muted ? containsStopWord(text) : isStopWord(text)) {
					handleStop(ctx);
					break;
				}
				if (muted) break; // drop self-echo transcript
				if (autoSend) {
					pi.sendUserMessage(`${MIC_PREFIX}${text}`);
				} else {
					// Push-to-send: drop the transcript into the prompt box and let
					// the user review + press Enter. Prefix 🎙 on a fresh draft; when
					// appending more dictation, don't repeat the marker.
					const existing = ctx.ui.getEditorText?.() ?? "";
					ctx.ui.setEditorText(existing ? `${existing} ${text}` : `${MIC_PREFIX}${text}`);
				}
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
		}
	}

	async function startVoice(ctx: ExtensionContext) {
		if (!ready || voiceOn()) return;
		setState("listening", ctx);
		ctx.ui.setStatus("swyft", "🎙 starting…");
		stt = startStt((msg) => handleStt(msg, ctx), { silenceMs: 1200 });
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
		description: "Cycle voice mode: off → auto (send on pause) → push-to-talk (fill prompt) → off",
		handler: async (_args, ctx) => {
			if (!ready) {
				ctx.ui.notify("swyft not ready — build the binary first.", "warning");
				return;
			}
			if (!voiceOn()) {
				// off → auto
				autoSend = true;
				await startVoice(ctx);
				ctx.ui.notify("Voice: auto — speak, sends on pause.", "info");
			} else if (autoSend) {
				// auto → push-to-talk
				autoSend = false;
				setState(state, ctx); // refresh status label
				ctx.ui.notify("Voice: push-to-talk — transcript fills the prompt, press Enter to send.", "info");
			} else {
				// push-to-talk → off
				await stopVoice(ctx);
				ctx.ui.notify("Voice mode off.", "info");
			}
		},
	});

	// LLM-callable: lets the agent turn voice mode on/off when the user asks.
	pi.registerTool({
		name: "voice_mode",
		label: "Voice Mode",
		description:
			"Turn native macOS voice mode on or off. When on, the user's speech is " +
			"transcribed into prompts and the agent's replies are read aloud. " +
			"mode 'auto' sends on pause; 'push' fills the prompt for the user to send.",
		promptSnippet: "Enable/disable spoken voice mode (mic dictation + read-aloud replies)",
		promptGuidelines: [
			"Call voice_mode when the user asks to turn voice/dictation/read-aloud on or off.",
		],
		parameters: Type.Object({
			action: StringEnum(["on", "off", "toggle"] as const),
			mode: Type.Optional(StringEnum(["auto", "push"] as const)),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!ready) {
				return {
					content: [{ type: "text", text: "swyft not ready — build it first (npm run build && npm run build:app)." }],
					details: { voiceOn, autoSend },
				};
			}
			const target = params.action === "toggle" ? !voiceOn() : params.action === "on";
			if (params.mode) autoSend = params.mode === "auto";
			if (target && !voiceOn()) await startVoice(ctx);
			else if (!target && voiceOn()) await stopVoice(ctx);
			else if (target && voiceOn()) setState(state, ctx); // refresh status after mode change
			const label = voiceOn() ? `on (${autoSend ? "auto" : "push"})` : "off";
			return { content: [{ type: "text", text: `Voice mode ${label}.` }], details: { voiceOn: voiceOn(), autoSend } };
		},
	});
}
