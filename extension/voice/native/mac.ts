// macOS native boundary: launch the Swift `swyft` binary / Swyft.app and move
// bytes between it and TypeScript. This is the ONLY file that knows about the
// swyft CLI, `open`, and the unix-socket callback transport. Providers call
// these helpers; the engine never sees them.

import { spawn, type ChildProcess, execFile } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import { appendFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readNdjson, type HelperVersion, type SttMessage, type SttOptions, type SttSession, type SpeakHandle, type Voice } from "../protocol";

const LOG_PATH = "/tmp/swyft-ext.log";
function log(msg: string): void {
	try {
		appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${msg}\n`);
	} catch {}
}

// extension/voice/native/mac.ts -> ../../../bin
const binDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "bin");
const SWYFT_BIN = join(binDir, "swyft");
const SWYFT_APP = join(binDir, "Swyft.app");

/** Both the CLI binary and the .app bundle must be present. */
export function binariesExist(): boolean {
	return existsSync(SWYFT_BIN) && existsSync(SWYFT_APP);
}

/** Read `swyft version` (JSON handshake). */
export function getVersion(): Promise<HelperVersion> {
	return new Promise((resolve, reject) => {
		execFile(SWYFT_BIN, ["version"], (err, stdout) => {
			if (err) return reject(err);
			try {
				resolve(JSON.parse(stdout.trim()));
			} catch (e) {
				reject(e);
			}
		});
	});
}

/**
 * Speak text aloud via `swyft tts`. Text is piped over stdin; killing the
 * process supports barge-in. `engine` (av | say | qwen) is optional; omit for
 * swyft's own `auto`. `voiceId` is an AVSpeech voice or a Qwen3 speaker id.
 */
export function speak(text: string, opts: { engine?: string; voiceId?: string } = {}): SpeakHandle {
	const args = ["tts"];
	if (opts.engine) args.push("--engine", opts.engine);
	if (opts.voiceId) args.push("--voice", opts.voiceId);
	const child = spawn(SWYFT_BIN, args, { stdio: ["pipe", "ignore", "ignore"] });
	child.stdin.on("error", () => {});
	child.stdin.end(text);
	// Resolve on the FIRST of exit/close/error so `speaking` can never get stuck
	// (a stuck handle would deadlock all further input). Safety timer too.
	const done = new Promise<void>((resolve) => {
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(() => {
			try {
				child.kill("SIGKILL");
			} catch {}
			finish();
		}, 120_000);
		child.on("exit", finish);
		child.on("close", finish);
		child.on("error", finish);
	});
	return {
		done,
		kill: () => {
			try {
				child.kill("SIGTERM");
			} catch {}
		},
	};
}

/** List installed TTS voices (parsed from `swyft voices` NDJSON). */
export function getVoices(): Promise<Voice[]> {
	return new Promise((resolve, reject) => {
		execFile(SWYFT_BIN, ["voices"], (err, stdout) => {
			if (err) return reject(err);
			const voices: Voice[] = [];
			for (const line of stdout.split("\n")) {
				const t = line.trim();
				if (!t) continue;
				try {
					voices.push(JSON.parse(t) as Voice);
				} catch {}
			}
			resolve(voices);
		});
	});
}

/** Play the soft ambient thinking sound until .kill() is called. */
export function hum(volume?: number): { kill: () => void } {
	const args = ["hum"];
	if (volume != null) args.push("--volume", String(volume));
	const child = spawn(SWYFT_BIN, args, { stdio: "ignore" });
	return { kill: () => child.kill("SIGTERM") };
}

/** Play the short "listening" earcon (fire-and-forget). */
export function chime(style = "bloop"): void {
	try {
		spawn(SWYFT_BIN, ["chime", "--style", style], { stdio: "ignore" });
	} catch {}
}

/**
 * Start STT: open a unix socket, launch Swyft.app (which detaches stdio, so it
 * connects back over the socket and streams NDJSON), stream parsed messages to
 * onMessage. `engine` selects apple | whisper inside swyft.
 */
export function startStt(
	onMessage: (msg: SttMessage) => void,
	opts: SttOptions & { engine?: string } = {},
): SttSession {
	const dir = join(tmpdir(), "swyft");
	mkdirSync(dir, { recursive: true });
	const sockPath = join(dir, `stt-${process.pid}-${Date.now()}.sock`);
	if (existsSync(sockPath)) unlinkSync(sockPath);

	let conn: Socket | null = null;
	let stopped = false;

	const server: Server = createServer((socket) => {
		conn = socket;
		log("Swyft.app connected to socket");
		socket.on("close", () => log("socket closed"));
		readNdjson(
			socket,
			(obj) => {
				log(`recv: ${JSON.stringify(obj)}`);
				onMessage(obj as SttMessage);
			},
			(raw) => {
				// keep a trace of unparsed lines too
				if (raw.length && raw[0] !== "{") log(`recv (unparsed): ${raw}`);
			},
		);
	});

	const cleanup = () => {
		try {
			server.close();
		} catch {}
		if (existsSync(sockPath)) {
			try {
				unlinkSync(sockPath);
			} catch {}
		}
	};

	server.on("error", (e) => log(`socket server error: ${String(e)}`));
	server.listen(sockPath, () => {
		const args = ["-n", SWYFT_APP, "--args", "stt", "--socket", sockPath];
		if (opts.silenceMs) args.push("--silence-ms", String(opts.silenceMs));
		if (opts.locale) args.push("--locale", opts.locale);
		if (opts.onDevice) args.push("--on-device");
		if (opts.engine) args.push("--engine", opts.engine);
		if (opts.model) args.push("--model", opts.model);
		log(`listening on ${sockPath}; launching: open ${args.join(" ")}`);
		const child: ChildProcess = spawn("open", args, { stdio: "ignore" });
		child.on("error", (e) => {
			log(`open failed: ${String(e)}`);
			onMessage({ type: "warn", message: "failed to launch Swyft.app" });
		});
		child.on("exit", (code) => log(`open exited code=${code}`));
	});

	return {
		stop: () => {
			if (stopped) return;
			stopped = true;
			try {
				conn?.write("stop\n");
			} catch {}
			setTimeout(cleanup, 300);
		},
		reset: () => {
			if (stopped) return;
			try {
				conn?.write("reset\n");
			} catch {}
		},
	};
}
