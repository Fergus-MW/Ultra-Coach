# Ultra Coach

A voice coach for ultramarathon training that listens to your heart rate strap and talks to you while you run.

Android first, Expo SDK 57. Built to the architecture described at https://ultra-coach.60x.ai/: instant on-device
cues plus an optional short push-to-talk conversation, rather than an always-listening realtime agent that would
flatten your battery and your music on a six hour day.

## How it works

| Concern | Approach |
| --- | --- |
| Heart rate | Direct BLE Heart Rate Service (`0x180D` / `0x2A37`). Cloud health APIs lag minutes behind, which is useless mid-effort. |
| GPS | `expo-location` at navigation accuracy; pace smoothed over 20 s, gradient over 40 m of travel. |
| Decisions | A synchronous, I/O-free rules engine (`src/coach/engine.ts`). A threshold crossing costs no network round trip. |
| Voice | ElevenLabs lines pre-rendered to the cache directory, so cues play instantly and offline. Dynamic lines synthesise live; `expo-speech` is the last resort. |
| Conversation | ElevenLabs agent over LiveKit, user-initiated, auto-closing after 30 s of quiet. Cues are muted while it holds the mic. |
| Testing without hardware | Simulated heart rate and route sources, with an effort bias control on the run screen. |
| Between runs | The Coach tab holds a socket to the coaching backend in `server/`: it rings the phone, the call takes over the screen, and the coach's Healf picks land in the Healf tab. |

The between-runs half is the same backend the PWA in `web/` talks to, so a phone and a browser share one runner
history. Point a build at another one with `EXPO_PUBLIC_API_BASE`, or `expo.extra.apiBase` in `app.json`.

## Running it

Native BLE and the conversational agent need a development build — Expo Go cannot load those modules.

```bash
npm install
npx expo prebuild --platform android
npx expo run:android
```

Then, in Settings: paste your ElevenLabs API key, optionally set a voice id and a conversational agent id, and tap
**Pre-cache cues** while you have signal. Generate a training plan from your race date and current volume, and start
the day's session from the Today tab.

The key is held in `expo-secure-store` and never leaves the device except in requests to ElevenLabs.

## Checks

```bash
npm run lint
npm run typecheck
npm test
```
