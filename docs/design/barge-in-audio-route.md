# Design: barge-in during speech via audio-route detection

## Problem

While the assistant is reading a reply aloud (TTS), the mic picks up our own
audio through the speakers. To avoid transcribing ourselves into a feedback
loop, we suppress all mic input during playback (plus a ~700ms tail), except
stop words. Consequence: the user cannot talk over the assistant to steer/barge
in while it speaks. Talking over the *thinking hum* already works (no audio out,
no echo).

## Idea

If output is NOT going through the built-in speakers (headphones, headphone
jack, USB, etc.), there's little/no echo, so we can safely relax echo
suppression and allow full barge-in.

## Contract split (agreed direction)

**Providers report facts; the central runner owns policy.**

- Platform-specific native code reports only *what the audio route is* and
  *whether it is echo-prone*. It does NOT decide whether barge-in is allowed.
- The extension (central runner) owns the policy: given the route fact, decide
  whether to relax `inputMuted()` during `speaking`.
- Rationale: keeps Swift/Windows code dumb and identical in contract; keeps the
  "should we suppress" logic in one tunable place; avoids policy drift across
  platforms.

## Proposed interface (protocol.ts)

Platform-agnostic enum + fact, hidden wire format (same pattern as STT/TTS):

```ts
export type AudioRoute =
  | "builtin-speakers"
  | "headphones"   // wired jack / analog
  | "bluetooth"
  | "usb"
  | "hdmi"
  | "unknown";

export interface AudioOutput {
  route: AudioRoute;
  /** True when playback is likely to echo into the mic (built-in speakers,
      and conservatively `unknown`). Runner uses this, not `route`, for policy. */
  echoRisk: boolean;
}
```

Two exposure options considered:

1. **One-shot on the version/capabilities handshake** — cheap, but stale if the
   user plugs in headphones mid-session.
2. **Small provider with a live subscription** (preferred):

```ts
export interface AudioRouteProvider extends ProviderMeta {
  current(): Promise<AudioOutput>;
  /** Optional: notify on route change so we react to headphones being
      plugged/unplugged mid-session. Returns an unsubscribe. */
  onChange?(cb: (out: AudioOutput) => void): () => void;
}
```

Register under `registry.audio` alongside `stt`/`tts`/`cues`.

## Platform implementations

- **macOS (Swift):** CoreAudio HAL — read the default output device
  (`kAudioHardwarePropertyDefaultOutputDevice`) and its
  `kAudioDevicePropertyTransportType`
  (`kAudioDeviceTransportTypeBuiltIn` → echoRisk true;
  `...Headphones`/`USB`/`Bluetooth` → echoRisk false). Map to the enum. For
  live changes, add a property listener on the default-output-device property.
- **Windows (later):** MMDevice API — default render endpoint + form factor
  (`PKEY_AudioEndpoint_FormFactor`: `Speakers` → echoRisk true; `Headphones`/
  `Headset` → false). Same enum out.

Both translate their native wire format to `AudioOutput`; the runner never sees
CoreAudio or MMDevice.

## Runner policy (extension)

- `inputMuted()` stays as-is by default.
- When the current route has `echoRisk === false`, allow non-stop-word input to
  pass during `speaking` (i.e. treat barge-in like the hum case → steer).
- Keep it conservative: `unknown` → echoRisk true (suppress). Bluetooth
  *speakers* would false-positive as safe; acceptable known limitation, or gate
  behind a config opt-in.
- Optional config flag to force-enable/disable regardless of detected route.

## Status

Not implemented — captured for later. The steer-during-hum fix and the TTS-hang
watchdog shipped in v0.10.3 (#45).
