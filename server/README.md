# Ultra Coach — proactive voice backend

FastAPI service behind the voice-only PWA in `../web`. It never hands a credential to the
browser: the client asks for a short-lived ElevenLabs conversation token and nothing else.

The Android app in the repo root is a separate product and is untouched by this service.

## Pieces

| Module | Job |
| --- | --- |
| `app/memory.py` | Zep temporal graph: transcripts, structured events, open commitments |
| `app/grok.py` | xAI Grok writes the opening line of a proactive call |
| `app/llm.py` | OpenAI-compatible proxy so the ElevenLabs agent runs on Grok with Zep context |
| `app/races.py` | Tavily search for 50K/50M/100K/100M races, summarised for speech |
| `app/ws.py` | Per-runner WebSocket fan-out — this is how the app "rings" |
| `app/proactive.py` | APScheduler sweeps: daily check-in, 15-minute reachability, 20h cooldown |
| `app/voice.py` | Conversation tokens plus the agent definition pushed to ElevenLabs |

## Routes

| Route | Used by |
| --- | --- |
| `GET /health` | Render health check |
| `POST /api/session` | PWA, before answering a call |
| `POST /api/proactive-ring/{user_id}` | Manual trigger of a call |
| `POST /webhooks/elevenlabs-transcript` | ElevenLabs post-call webhook |
| `POST /tools/search-races` | ElevenLabs server tool `search_ultra_events` |
| `POST /llm/chat/completions` | ElevenLabs custom LLM |
| `WS /ws/{user_id}` | PWA ring channel and call outcomes |

## Local run

```bash
uv venv && . .venv/bin/activate && uv pip install -r requirements.txt
cp .env.example .env   # fill in
uvicorn app.main:app --reload
pytest && ruff check .
```

## ElevenLabs agent

`app/voice.py` holds the persona, the custom-LLM pointer and the `search_ultra_events` tool.
Push it once the backend has a public URL:

```bash
PUBLIC_BASE_URL=https://ultracoach-api.onrender.com python scripts/sync_agent.py
```

Put the printed agent id in `ELEVENLABS_AGENT_ID`.

## Deploy

`../render.yaml` defines the API and the PWA. Secrets are `sync: false`, so set them in the
Render dashboard — never in the blueprint. Use a paid instance: proactive calling needs a
process that does not sleep.
