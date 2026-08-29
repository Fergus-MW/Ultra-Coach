# Ultra Coach — voice-only PWA

The coach calls you. There is no text input anywhere in this app, by design: identity is a
device-scoped id in `localStorage`, and everything else is said out loud.

- Holds a WebSocket to `/ws/{runner_id}`; an `incoming_call` event puts the phone-style
  overlay on screen and starts a synthesised ringtone.
- Answering asks the backend for a short-lived ElevenLabs conversation token and opens a
  WebRTC session, seeded with the Grok-written opening line and the runner's Zep context.
- Declining and answering are both reported back over the socket so the coach remembers.
- Installable: `app/manifest.ts` plus a shell-only service worker.

```bash
echo 'NEXT_PUBLIC_API_BASE=http://localhost:8000' > .env.local
npm install && npm run dev
```

Microphone access needs a secure context, so use `localhost` or HTTPS.
