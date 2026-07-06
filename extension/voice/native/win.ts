// Windows native boundary — STUB (no implementation yet).
//
// Shape mirrors native/mac.ts, but the transport differs:
//  - Launch: spawn the helper exe directly (no `.app`, no `open`). Because the
//    exe keeps its stdio, STT could stream NDJSON straight over stdout instead
//    of a callback socket — but to keep one engine code path we still use a
//    server the helper connects back to.
//  - Transport: a named pipe (`\\.\pipe\picrophone-stt-<pid>-<ts>`) instead of
//    a unix socket. Node's `net` API handles both via `server.listen(path)`;
//    only the path shape differs, so the read loop (readNdjson) is reused as-is.
//  - Cues: handled cross-platform by cues/wav.ts (PowerShell SoundPlayer), so no
//    native hum/chime is needed here.
//
// When implemented, expose the same surface as mac.ts: binariesExist,
// getVersion, speak, getVoices, startStt. TTS/STT providers would branch on
// process.platform (or separate win-tagged provider files) to call these.

import type { SttMessage, SttOptions, SttSession, SpeakHandle } from "../protocol";

const UNIMPLEMENTED = "Windows native helper is not implemented yet.";

/** Named-pipe path for the STT callback server (documented shape). */
export function sttPipePath(): string {
	return `\\\\.\\pipe\\picrophone-stt-${process.pid}-${Date.now()}`;
}

export function binariesExist(): boolean {
	return false;
}

export function speak(_text: string, _opts: { engine?: string; voiceId?: string } = {}): SpeakHandle {
	throw new Error(UNIMPLEMENTED);
}

export function startStt(_onMessage: (msg: SttMessage) => void, _opts: SttOptions & { engine?: string } = {}): SttSession {
	throw new Error(UNIMPLEMENTED);
}
