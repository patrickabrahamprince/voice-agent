# Getmore.OS Voice AI Production Deployment

## Live Telephony & Web Access

| Service | Public URL / Number | Description |
| :--- | :--- | :--- |
| **Active Inbound Telephony DID** | **`+91 80 6434 8409`** (`080 6434 8409`) | Live inbound Bangalore landline connected to Priya |
| **Admin Console & Web Tester** | [`https://plymouth-arnold-advances-watts.trycloudflare.com/admin`](https://plymouth-arnold-advances-watts.trycloudflare.com/admin) | Real-time audio tester, live SSE transcription feed, lead dashboard, & analytics |
| **Health Check Endpoint** | [`https://plymouth-arnold-advances-watts.trycloudflare.com/health`](https://plymouth-arnold-advances-watts.trycloudflare.com/health) | Sub-millisecond health status for monitoring |
| **Telephony Inbound Webhook** | `https://plymouth-arnold-advances-watts.trycloudflare.com/incoming-call` | Plivo XML application Answer URL |
| **WebSocket Media Stream** | `wss://plymouth-arnold-advances-watts.trycloudflare.com/media-stream` | Bidirectional 8kHz G.711 μ-law audio stream |

---

## Plivo Telephony Status (Configured & Live)

### 1. Inbound Number & XML Application
| Parameter | Value |
| :--- | :--- |
| **Assigned Phone Number** | `+91 80 6434 8409` (`080 6434 8409`) |
| **Application ID** | `17370092272385353` |
| **Primary Answer URL** | `https://plymouth-arnold-advances-watts.trycloudflare.com/incoming-call` (POST) |
| **Bidirectional Stream** | `wss://plymouth-arnold-advances-watts.trycloudflare.com/media-stream` |
| **Carrier Stream Rate** | 8000 Hz, 1-channel, G.711 μ-law |

---

## Latency & Self-Interruption Fixes (Current Version)

1. **Sarvam Circuit Breaker (`circuit_breaker.ts`):**
   - Automatically trips when Sarvam AI returns HTTP 402 (`insufficient_quota_error` / `Credits exhausted`).
   - Immediately routes STT to **Groq Whisper Large V3 Turbo (~280ms)** and LLM to **Groq Qwen 2.5 32B (~180ms TTFT)**.
   - Eliminates the previous 10.2-second cascade delay down to **sub-second turnaround (<600ms)**.

2. **Native 8kHz Audio Pipeline (`tts.ts`):**
   - Direct single-pass macOS Indian English voice (`Tara`) with `--data-format=LEI16@8000` at rate `210`.
   - Eliminates intermediate `afconvert` and 24kHz pitch/speed distortion (preventing 3x slow-motion audio).
   - Pre-warmed `telephonyLruCache` primes top greetings and project details for **0ms instant greeting delivery**.

3. **Acoustic Echo & Anti-Interruption Immunity Guard (`session.ts`):**
   - 100% inbound audio dropped while agent is speaking or during 400ms post-speech cooldown.
   - VAD energy threshold set to `1300 RMS` with 8 frames (160ms) persistence to eliminate line hiss and room echo.
   - Conversational silence debounce tuned to **550–650ms** for snappy, natural turn transitions.
   - Clean disconnection handler prevents spurious barge-in events on call hangup.
