// Bridge to the native swyft binary / Swyft.app.
// - TTS: spawn `swyft tts`, text via stdin (killable for barge-in).
// - STT: listen on a unix socket, launch Swyft.app which connects back and
//   streams NDJSON; control it via a `stop` line over the same socket.

import { spawn, type ChildProcess, execFile } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import { appendFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LOG_PATH = "/tmp/swyft-ext.log";
function log(msg: string): void {
	try {
		appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${msg}\n`);
	} catch {}
}

const binDir = join(dirname(fileURLToPath(import.meta.url)), "..", "bin");
const SWYFT_BIN = join(binDir, "swyft");
const SWYFT_APP = join(binDir, "Swyft.app");

export interface SwyftVersion {
	name: string;
	version: string;
	protocol: number;
	capabilities: string[];
	/** Running macOS version, e.g. "15.7.4" (added in later builds). */
	os?: string;
	/** TTS engines available on this OS, best-first, e.g. ["av","say"]. */
	ttsEngines?: string[];
	/** Engine `--engine auto` resolves to on this OS. */
	ttsEngine?: string;
}

export type SttMessage =
	| { type: "ready" }
	| { type: "partial"; text: string }
	| { type: "final"; text: string }
	| { type: "permission"; mic: string; speech: string }
	| { type: "warn"; message: string };

export function binariesExist(): boolean {
	return existsSync(SWYFT_BIN) && existsSync(SWYFT_APP);
}

export function getVersion(): Promise<SwyftVersion> {
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
 * Speak text aloud. Returns a handle whose .kill() supports barge-in.
 * `engine` defaults to swyft's own `auto` (best available for the macOS
 * version); pass "av" | "say" | "neural" to force one.
 */
export function speak(
	text: string,
	engine?: string,
): { done: Promise<void>; kill: () => void } {
	const args = engine ? ["tts", "--engine", engine] : ["tts"];
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

export interface SttSession {
	stop: () => void;
	/** Discard any audio the recognizer accumulated (e.g. our own TTS echo). */
	reset: () => void;
}

/** Start STT: open a socket, launch Swyft.app, stream messages to onMessage. */
export function startStt(
	onMessage: (msg: SttMessage) => void,
	opts: { silenceMs?: number; locale?: string; onDevice?: boolean } = {},
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
		let buf = "";
		socket.on("data", (chunk) => {
			buf += chunk.toString("utf8");
			let nl: number;
			while ((nl = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, nl).trim();
				buf = buf.slice(nl + 1);
				if (!line) continue;
				try {
					const msg = JSON.parse(line) as SttMessage;
					log(`recv: ${line}`);
					onMessage(msg);
				} catch {
					log(`recv (unparsed): ${line}`);
				}
			}
		});
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
