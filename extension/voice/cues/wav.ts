// Default, cross-platform cues: play baked WAV assets via the system player.
// - macOS: `afplay`
// - Windows: PowerShell System.Media.SoundPlayer (STUB path shape; verified later)
// Removes hum/chime synthesis from swyft (and from any future native helper);
// the WAVs are baked from the original Swift DSP (scripts/bake-cues.mjs) so the
// sound is unchanged.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CueHandle, CuesProvider, CueStyle, Readiness } from "../protocol";

// extension/voice/cues/wav.ts -> ../../../assets
const assetsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "assets");
const HUM_WAV = join(assetsDir, "hum.wav");
const chimeWav = (style: CueStyle) => join(assetsDir, `chime-${style}.wav`);

/** Spawn the platform WAV player for one file; returns the child (or null). */
function playOnce(file: string): ChildProcess | null {
	try {
		if (process.platform === "win32") {
			return spawn(
				"powershell",
				["-NoProfile", "-Command", `(New-Object Media.SoundPlayer '${file}').PlaySync()`],
				{ stdio: "ignore" },
			);
		}
		// macOS (and Linux with afplay available).
		return spawn("afplay", [file], { stdio: "ignore" });
	} catch {
		return null;
	}
}

export const wavCues: CuesProvider = {
	id: "wav",
	label: "Baked WAV cues",
	// Player is present on macOS; Windows path is a documented stub until tested.
	supports: ["darwin", "win32"],
	needsBinary: false,
	readiness(): Readiness {
		return existsSync(HUM_WAV)
			? { available: true }
			: { available: false, reason: "cue WAV assets missing — run `node scripts/bake-cues.mjs`." };
	},
	hum(): CueHandle {
		// Loop the one-cycle hum by respawning the player when it exits.
		let killed = false;
		let child: ChildProcess | null = null;
		const loop = () => {
			if (killed) return;
			child = playOnce(HUM_WAV);
			child?.on("exit", () => {
				if (!killed) loop();
			});
			if (!child) killed = true; // player unavailable; give up quietly
		};
		loop();
		return {
			kill: () => {
				killed = true;
				try {
					child?.kill("SIGTERM");
				} catch {}
			},
		};
	},
	chime(style: CueStyle = "bloop"): void {
		const file = chimeWav(style);
		if (existsSync(file)) playOnce(file);
	},
};
