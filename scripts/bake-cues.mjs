// Bake the swyft-synthesized hum + chime cues to WAV assets, reproducing the
// exact DSP from swyft/Sources/swyft/Hum.swift and Chime.swift so the baked
// sound matches the live one byte-for-ear. Run: node scripts/bake-cues.mjs
// Output: assets/hum.wav (one loopable pulse cycle) + assets/chime-*.wav.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SR = 48000; // AVAudioEngine default output sample rate
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");

// Encode a mono Float array (-1..1) to a 16-bit PCM WAV buffer.
function encodeWav(samples, sampleRate = SR) {
	const n = samples.length;
	const buf = Buffer.alloc(44 + n * 2);
	buf.write("RIFF", 0);
	buf.writeUInt32LE(36 + n * 2, 4);
	buf.write("WAVE", 8);
	buf.write("fmt ", 12);
	buf.writeUInt32LE(16, 16); // fmt chunk size
	buf.writeUInt16LE(1, 20); // PCM
	buf.writeUInt16LE(1, 22); // mono
	buf.writeUInt32LE(sampleRate, 24);
	buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
	buf.writeUInt16LE(2, 32); // block align
	buf.writeUInt16LE(16, 34); // bits per sample
	buf.write("data", 36);
	buf.writeUInt32LE(n * 2, 40);
	for (let i = 0; i < n; i++) {
		let s = Math.max(-1, Math.min(1, samples[i]));
		buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
	}
	return buf;
}

// --- Hum (one loopable pulse cycle) -----------------------------------------
// Mirrors Hum.swift: warm C3 note with a slow decay + feedback echo, pulsing
// every `interval` seconds. One cycle loops seamlessly (tail decays < interval).
function bakeHum() {
	const volume = 0.22;
	const interval = 2.4;
	const freq = 130.81; // C3
	const decay = 2.2;
	const noteDur = 1.8;
	const attack = 0.02;
	const delaySamples = Math.max(1, Math.round(0.33 * SR));
	const feedback = 0.5;

	const total = Math.round(interval * SR);
	const delay = new Float32Array(delaySamples);
	let delayIdx = 0;
	const out = new Float32Array(total);
	for (let n = 0; n < total; n++) {
		const t = n / SR; // note starts at n=0 for a single cycle
		let dry = 0;
		if (t < noteDur) {
			let env = Math.exp(-decay * t);
			if (t < attack) env *= t / attack;
			const w = Math.sin(2 * Math.PI * freq * t) + 0.4 * Math.sin(2 * Math.PI * 2 * freq * t);
			dry = w * env;
		}
		const echoed = delay[delayIdx];
		const o = dry + echoed;
		delay[delayIdx] = dry + echoed * feedback;
		delayIdx = (delayIdx + 1) % delaySamples;
		out[n] = o * volume;
	}
	return out;
}

// --- Chime (per style) ------------------------------------------------------
// Mirrors Chime.swift note tables + envelope.
const CHIME_STYLES = {
	triad: [[0.0, 523.25], [0.1, 659.25], [0.2, 783.99]],
	ping: [[0.0, 1046.5]],
	bloop: [[0.0, 783.99], [0.12, 1046.5]],
	blip: [[0.0, 1046.5], [0.12, 1318.51]],
	pop: [[0.0, 880.0], [0.1, 1318.51]],
	dew: [[0.0, 1046.5], [0.1, 1567.98]],
	glass: [[0.0, 659.25], [0.11, 987.77]],
	down: [[0.0, 880.0], [0.14, 587.33]],
	fifth: [[0.0, 587.33], [0.14, 880.0]],
};

function bakeChime(style) {
	const volume = 0.18;
	const noteDur = 0.32;
	const notes = CHIME_STYLES[style];
	const shimmer = style === "glass";
	const lastStart = Math.max(...notes.map((x) => x[0]));
	const totalDur = lastStart + 0.45;
	const total = Math.round(totalDur * SR);
	const out = new Float32Array(total);
	for (let n = 0; n < total; n++) {
		const t = n / SR;
		let s = 0;
		for (const [start, freq] of notes) {
			const dt = t - start;
			if (dt >= 0 && dt < noteDur) {
				const env = Math.exp(-5.0 * dt);
				let w = Math.sin(2 * Math.PI * freq * dt) + 0.3 * Math.sin(2 * Math.PI * 2 * freq * dt);
				if (shimmer) w += 0.2 * Math.sin(2 * Math.PI * 3 * freq * dt);
				s += w * env;
			}
		}
		out[n] = s * volume;
	}
	return out;
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "hum.wav"), encodeWav(bakeHum()));
console.log("wrote assets/hum.wav");
for (const style of Object.keys(CHIME_STYLES)) {
	writeFileSync(join(OUT, `chime-${style}.wav`), encodeWav(bakeChime(style)));
	console.log(`wrote assets/chime-${style}.wav`);
}
