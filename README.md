# Trishul Mittal Palms — Enterprise Inbound Voice AI Agent

A production-grade, ultra-low-latency Inbound Telephony Voice AI Agent engineered for **Trishul Mittal Palms in Jakkur, North Bangalore**.

The agent answers cellular telephone calls over 8kHz G.711 μ-law bidirectional WebSockets, autonomously qualifies inbound prospective buyers across 2 and 3 BHK configurations, handles objections and property FAQs, schedules on-site walkthroughs with on-site advisor **Dylan Dsouza**, and syncs structured lead data to **Google Sheets** and a local **SQLite audit database** in real time.

---

## 📞 Live Telephony & Web Access

| Service | Public URL / Number | Description |
| :--- | :--- | :--- |
| **Inbound Telephony Line** | **`+91 80 6434 8409`** (`080 6434 8409`) | Live inbound Bangalore landline connected to Priya |
| **Admin Console & Tester** | `http://localhost:3001/admin` | Real-time audio tester, live SSE transcription feed, lead dashboard |
| **Default Login** | `admin` • `mittal@palms2026` | Configurable via environment variables |
| **On-Site Property Advisor** | **Dylan Dsouza** (`8064348409`) | Hosted on-site visits and apartment walkthroughs |
| **Registered Project Email** | `niraj@mittal.com` | Primary lead notification destination |

---

## 🏗️ Architecture & Voice AI Pipeline

```
                                    ┌────────────────────────────────────────────────────────┐
                                    │               Plivo Enterprise PBX                     │
                                    │             (DID: +91 80 6434 8409)                    │
                                    └────────────────────────┬───────────────────────────────┘
                                                             │  POST /incoming-call (Plivo XML)
                                                             │  WSS /media-stream (8kHz G.711 μ-law)
                                                             ▼
┌──────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ Fastify Server & Bi-Directional Session Coordinator (src/server.ts, src/pipeline/session.ts)              │
├──────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                                          │
│   Caller Audio In                                                                    Audio Out           │
│   (base64 μ-law)                                                                  (base64 μ-law)         │
│        │                                                                                ▲                │
│        ▼                                                                                │                │
│  ┌─────────────────────────┐         Barge-In Interruption (<50ms)            ┌─────────────────────┐    │
│  │ Sarvam Saaras v3 STT    │ ───────────────────────────────────────────────► │ PBX Clear Audio     │    │
│  │ (Auto English/Hindi)    │   (Flushes PBX buffer, aborts Groq, stops TTS)   │ Buffer Event        │    │
│  └────────────┬────────────┘                                                  └─────────────────────┘    │
│               │ Transcript tokens                                                       ▲                │
│               ▼                                                                         │ Audio Chunks   │
│  ┌─────────────────────────┐    syncLeadRecord (Auto)    ┌───────────────────────────┐  │ (8kHz μ-law)   │
│  │ Groq Qwen 2.5 27B       │ ──────────────────────────► │ Google Sheets Sync        │  │                │
│  │ (~200ms TTFT, Bilingual)│                             │ & SQLite Audit Persistence│  │                │
│  └────────────┬────────────┘                             └───────────────────────────┘  │                │
│               │ Streaming tokens                                                        │                │
│               ▼                                                                         │                │
│  ┌─────────────────────────┐                                                            │                │
│  │ Speech Normalizer       │ ───────────────────────────────────────────────────────────┤                │
│  │ (Crores/BHK/Phonetics)  │   (Regex: "1.5 Cr" -> "one point five crore rupees")       │                │
│  └────────────┬────────────┘                                                            │                │
│               │ Normalized sentence fragments                                           │                │
│               ▼                                                                         │                │
│  ┌──────────────────────────────────────────────────────────────────────────────────────┴─────────────┐  │
│  │ Sarvam AI Bulbul Streaming TTS (bulbul:v4-flash • Simran Bilingual enhi • ~250ms TTFA)            │  │
│  │ Dynamic language code switching: hi-IN for Hindi/Hinglish, en-IN for English                      │  │
│  └────────────────────────────────────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## ⚡ Core Capabilities

1. **Sub-500ms End-to-End Latency**:
   - Bi-directional 8kHz G.711 μ-law audio over WebSocket streaming directly to/from Plivo.
   - Groq Qwen 2.5 27B delivers Time-To-First-Token in ~180–250ms.
   - Sarvam AI Bulbul WebSocket streaming delivers Time-To-First-Audio in ~250ms.
2. **Sub-50ms Instant Barge-In Interruption**:
   - Instant acoustic detection when caller speaks while Priya is speaking.
   - Dispatches `{"event": "clearAudio"}` to Plivo to stop outbound playback instantly.
   - Aborts ongoing LLM generation and cancels active TTS synthesis in 0ms.
3. **Dynamic Bilingual Continuity (English & Hindi/Hinglish)**:
   - Priya greets in warm Bangalore Indian English.
   - If the caller speaks Hindi or asks to switch (*"Hindi mein"*), Priya smoothly transitions to conversational Hindi/Hinglish.
   - **Persistent language tracking**: Priya stays in Hindi throughout subsequent turns, including hesitations (*"Hmm"* ➔ *"Ji, batayein!"*) and short affirmations (*"Hanji"*).
   - Only switches back to English if the caller explicitly requests it.
4. **Zero Rate-Limit Delays**:
   - System prompt compacted to ~350 tokens, eliminating Groq free-tier rate-limit throttling (HTTP 429).
   - Configured with zero SDK backoff sleep (`maxRetries: 0`) and dynamic single-line objection coaching.
5. **Acoustic Voice Energy Gating**:
   - Eliminates mobile speakerphone echo loops and ringdown clicks.
   - Discards noise frames under 1300 RMS and manages speech cooldown without locking the microphone.
6. **Real Estate Speech Normalizer (`src/pipeline/normalizer.ts`)**:
   - Converts Indian currency and figures to natural spoken phonetics:
     - `1.5 Cr` → `one point five crore rupees`
     - `85L` → `eighty-five lakh rupees`
     - `3 BHK` → `3 B H K`
     - `11 AM` → `11 A M`
     - `₹12,000/sqft` → `twelve thousand rupees per square foot`
7. **Priya Senior Property Advisor Persona (`src/pipeline/llm.ts`)**:
   - Ultra-crisp spoken responses strictly 1–2 short sentences (under 16 words).
   - Explores 2 BHK (1,235–1,340 sq ft, ₹1.25–1.35 Cr) and 3 BHK (1,720–1,980 sq ft, ₹1.7–1.95 Cr).
   - Confirms ready-to-move-in Occupancy Certificate (OC) received (0% GST).
   - Schedules on-site walkthroughs with on-site advisor **Dylan Dsouza**.
8. **Real-Time Dual Persistence (`src/tools/sheets.ts` & `src/tools/db.ts`)**:
   - **Google Sheets Sync**: Appends qualified leads via Service Account JWT authentication.
   - **SQLite Audit Database**: Full call transcripts, duration, lead score, and summaries stored locally (`data/voice_agent.db`).
9. **Real-Time Web Console & Dialogue Feed (`/admin`)**:
   - Live Server-Sent Events (SSE) feed displaying real-time speaker dialogue bubbles and acoustic indicators.
   - Built-in interactive browser audio tester for simulated inbound calls.
   - One-click CSV export of all qualified buyer leads.

---

## 📁 Project Structure

```
.
├── Dockerfile                  # Multi-stage production Debian/glibc container build
├── README.md                   # Complete system documentation
├── package.json                # Dependencies, scripts, and build targets
├── tsconfig.json               # TypeScript compiler configuration
├── .env.example                # Documented environment variable template
├── data/
│   ├── voice_agent.db          # SQLite audit database (WAL mode, auto-created)
│   └── seed_data.json          # Project configuration and property specs
├── src/
│   ├── server.ts               # Fastify server, Plivo webhook, auth guard, and Admin routes
│   ├── dashboard/
│   │   └── index.html          # Real-time Admin Console, Live Feed, and Call Simulator
│   ├── pipeline/
│   │   ├── session.ts          # Bi-directional WebSocket coordinator, VAD, and barge-in
│   │   ├── llm.ts              # Groq Qwen 2.5 27B pipeline, system prompt, and learnings
│   │   ├── tts.ts              # Sarvam AI Bulbul TTS and Saaras v3 STT integration
│   │   ├── streaming_tts.ts    # Persistent WebSocket streaming TTS client
│   │   ├── normalizer.ts       # Real estate currency and BHK speech normalizer
│   │   ├── turn_detector.ts    # Acoustic & linguistic turn completion evaluator
│   │   ├── objections.ts       # Objection detection heuristics and playbook
│   │   ├── qualifier.ts        # Lead extraction state machine
│   │   ├── events.ts           # Live call event broadcaster (SSE / WebSockets)
│   │   └── circuit_breaker.ts  # Quota protection circuit breaker
│   ├── telephony/
│   │   └── plivo.ts            # Plivo signature verification and XML stream builder
│   └── tools/
│       ├── db.ts               # SQLite schema, queries, and CSV exporter
│       └── sheets.ts           # Google Sheets Service Account synchronization
├── scripts/
│   ├── update-plivo-url.ts     # Utility to point Plivo application to active domain
│   ├── test-full-workflow.ts   # End-to-end integration test
│   └── overnight_runner.ts     # Stress & reliability test runner
└── tests/
    └── simulate_calls.ts       # Autonomous multi-scenario telephony benchmark suite
```

---

## 🚀 Getting Started

### 1. Prerequisites
- **Node.js** v20+ (Node v24 tested)
- **npm** v10+

### 2. Installation
```bash
npm install
```

### 3. Environment Configuration
Copy `.env.example` to `.env` and fill in your credentials:
```bash
cp .env.example .env
```

Key environment variables:
```env
PORT=3001
HOST=localhost:3001
PUBLIC_DOMAIN=your-production-domain.com

# Admin Authentication
ADMIN_USERNAME=admin
ADMIN_PASSWORD=mittal@palms2026
ADMIN_SECRET_TOKEN=mittal_palms_secret_2026

# Telephony (Plivo)
TELEPHONY_PROVIDER=plivo
PLIVO_AUTH_ID=MANXXXXXXXXXXXXXXXXX
PLIVO_AUTH_TOKEN=your_plivo_auth_token_here
PLIVO_PHONE_NUMBER=+918064348409
PLIVO_APP_ID=17370092272385353

# Voice AI Stack
GROQ_API_KEY=your_groq_api_key_here
SARVAM_API_KEY=your_sarvam_api_key_here
OPENROUTER_API_KEY=your_openrouter_api_key_here

# Lead Sync
LEAD_EMAIL=niraj@mittal.com
GOOGLE_SHEET_ID=your_sheet_id_here
GOOGLE_SERVICE_ACCOUNT_EMAIL=service-account@project.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

### 4. Running the Server

#### Development Mode (with hot-reload):
```bash
npm run dev
```

#### Production Build & Start:
```bash
npm run build
npm start
```

The server listens on port `3001`:
- **Inbound Webhook**: `http://localhost:3001/incoming-call`
- **Media Stream WebSocket**: `ws://localhost:3001/media-stream`
- **Admin Console & Tester**: `http://localhost:3001/admin` (or `http://localhost:3001/`)
- **Health Check**: `http://localhost:3001/health`

---

## 📞 Plivo Telephony Carrier Setup

1. In the **Plivo Console** (`console.plivo.com`):
   - Purchase or select your Bangalore DID (e.g. `+91 80 6434 8409`).
2. Create or configure an **XML Application**:
   - **Primary Answer URL**: `https://<YOUR_DOMAIN>/incoming-call`
   - **Answer Method**: `POST`
3. Associate your XML Application with your Phone Number under **Phone Numbers ➔ Your Numbers**.
4. To automatically update Plivo with your domain via CLI:
   ```bash
   npx tsx scripts/update-plivo-url.ts
   ```

When an inbound call arrives, Plivo fetches the XML response and establishes a bidirectional 8kHz audio stream:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Stream bidirectional="true" streamTimeout="86400">wss://<YOUR_DOMAIN>/media-stream</Stream>
</Response>
```

---

## 🧪 Testing & Verification Suites

### 1. Multi-Turn Telephony Simulation
Runs 4 autonomous customer scenarios (High-Intent, Amenities & Barge-in, Budget Mismatch, Hinglish Buyer):
```bash
npm run test:sim
```
*Average response latency: ~390ms (Target: <600ms).*

### 2. Speech Normalizer & SQLite Audit Test
Verifies currency conversion, regex formatting, and database CSV export:
```bash
npx tsx test/test-pipeline.ts
```

### 3. Browser-Based Call Tester
1. Open `http://localhost:3001/admin` in any browser.
2. Sign in with `admin` / `mittal@palms2026`.
3. In the **Interactive Tester** tab, click **Start Call**.
4. Test real estate dialogue, Hindi language switching, or click **Test Barge-In** to verify sub-50ms buffer clearance.

---

## 🐳 Docker Deployment

A multi-stage Debian-based `Dockerfile` with native `better-sqlite3` build tools is included:

```bash
# Build Docker image
docker build -t voice-agent .

# Run container
docker run -d -p 3001:3001 --env-file .env --name voice-agent voice-agent
```

---

## 📄 License
MIT License. Engineered for Trishul Mittal Palms, Jakkur, Bangalore.
