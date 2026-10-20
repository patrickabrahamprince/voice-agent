# VaniAgent: Bangalore Real Estate Inbound Voice AI Agent

A production-grade, ultra-low-latency Inbound Telephony Voice AI Agent engineered for **Mittal Palms, Jakkur, North Bangalore**. The agent answers live cellular telephone calls over 8kHz G.711 μ-law bidirectional WebSockets, qualifies inbound buyer leads across 2 and 3 BHK configurations, schedules on-site walkthroughs with Raghavendra (9945577935), registers leads to niraj@mittal.com, and syncs structured lead data to **Google Sheets** and a local **SQLite audit database** in real time.

---

## 🏗️ Architecture & Voice AI Pipeline

```
                                      ┌────────────────────────────────────────────────────────┐
                                      │              Cellular Telephony PBX                    │
                                      │                 (Twilio / Exotel)                      │
                                      └────────────────────────┬───────────────────────────────┘
                                                               │  POST /incoming-call (TwiML)
                                                               │  WSS /media-stream (8kHz G.711 μ-law)
                                                               ▼
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ Fastify Server & Bi-Directional Session Coordinator (src/server.ts, src/pipeline/session.ts)  │
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                              │
│   Caller Audio In                                                            Audio Out       │
│   (base64 μ-law)                                                          (base64 μ-law)     │
│        │                                                                        ▲            │
│        ▼                                                                        │            │
│  ┌──────────────┐         Interruption Trigger (<50ms)                   ┌──────────────┐    │
│  │ Deepgram STT │ ─────────────────────────────────────────────────────► │ PBX Clear    │    │
│  │ Nova-2 en-IN │   (Flushes PBX buffer, aborts Groq, cancels Cartesia)  │ Buffer Event │    │
│  └──────┬───────┘                                                        └──────────────┘    │
│         │ Transcript tokens                                                     ▲            │
│         ▼                                                                       │ Audio Chunks
│  ┌──────────────┐    qualify_and_sync_lead     ┌──────────────────────┐  ┌──────────────┐    │
│  │ Groq LLM     │ ───────────────────────────► │ Google Sheets Sync   │  │ Cartesia TTS │    │
│  │ LLaMA 3.3 70B│                              │ & SQLite Audit Fallback │ │ Sonic-Multi│    │
│  └──────┬───────┘                              └──────────────────────┘  └──────▲───────┘    │
│         │ Streaming tokens                                                      │            │
│         ▼                                                                       │            │
│  ┌──────────────┐                                                               │            │
│  │ Normalizer   │ ──────────────────────────────────────────────────────────────┘            │
│  │ (Crores/BHK) │   (Regex: "1.5 Cr" -> "one point five crore rupees", etc.)                 │
│  └──────────────┘                                                                            │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## ⚡ Core Capabilities

1. **Ultra-Low Latency Telephony Streaming**:
   - Bi-directional 8kHz G.711 μ-law audio over WebSocket.
   - Compatible out-of-the-box with **Twilio Media Streams** and **Exotel Audio Streams**.
2. **Sub-50ms Barge-In Interruption**:
   - Instant detection when the caller interrupts while Priya is speaking.
   - Sends `{"event": "clear", "streamSid": streamSid}` to clear carrier PBX audio buffers.
   - Immediately aborts the ongoing Groq token stream (`AbortController`) and cancels active Cartesia audio contexts.
3. **Bangalore Real Estate Speech Normalizer (`src/pipeline/normalizer.ts`)**:
   - Converts Indian currency and figures to natural spoken cadence:
     - `1.5 Cr` → `one point five crore rupees`
     - `85L` → `eighty-five lakh rupees`
     - `3 BHK` → `3 B H K`
     - `11 AM` → `11 A M`
   - Strips Markdown formatting, asterisks, and bullet points to preserve natural telephony speech.
4. **Priya Senior Property Advisor Persona (`src/pipeline/llm.ts`)**:
   - Concise spoken replies strictly under 2 sentences.
   - Discovers configuration, intent (self-use vs investment), micro-market, budget, and possession timeline.
   - Focuses on booking weekend site visits (Saturday/Sunday).
   - Executes the `qualify_and_sync_lead` tool immediately when qualified.
5. **Real-Time Dual Persistence (`src/tools/sheets.ts` & `src/tools/db.ts`)**:
   - **Google Sheets Sync**: Appends rows with Service Account JWT authentication.
   - **SQLite Audit Fallback**: Stores full call transcripts, duration, summaries, and lead records with zero latency.
6. **Built-In Admin Console & Call Simulator (`/admin`)**:
   - Live dashboard showing call history, transcripts, and qualified leads.
   - Interactive tester to test buyer dialogues, test barge-in, and view real-time sync.
   - One-click export of all leads to CSV.

---

## 📁 Project Structure

```
.
├── package.json
├── tsconfig.json
├── .env.example
├── .env
├── data/
│   └── voice_agent.db          # Local SQLite audit database (WAL mode)
├── src/
│   ├── server.ts               # Fastify server, telephony webhook, and Admin UI
│   ├── pipeline/
│   │   ├── session.ts          # WebSocket coordinator, audio routing, barge-in
│   │   ├── normalizer.ts       # Indian real estate currency and BHK speech normalizer
│   │   └── llm.ts              # Groq LLaMA 3.3 70B & qualify_and_sync_lead tool
│   └── tools/
│       ├── db.ts               # better-sqlite3 audit database and CSV exporter
│       └── sheets.ts           # googleapis Service Account Google Sheets sync
└── test/
    ├── test-pipeline.ts        # Unit test for normalizer and database
    └── test-server.ts          # End-to-end integration test
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
Copy `.env.example` to `.env` and fill in your API credentials:
```bash
cp .env.example .env
```

```env
PORT=3000
HOST=localhost:3000

# Voice AI Services
DEEPGRAM_API_KEY=your_deepgram_api_key_here
GROQ_API_KEY=your_groq_api_key_here
CARTESIA_API_KEY=your_cartesia_api_key_here

# Google Sheets Integration (Service Account)
GOOGLE_SHEET_ID=your_google_sheet_id_here
GOOGLE_SERVICE_ACCOUNT_EMAIL=your-service-account@your-project.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

### 4. Running the Development Server
```bash
npm run dev
```

The server boots on port `3000`:
- **Inbound Webhook**: `http://localhost:3000/incoming-call`
- **Media Stream**: `ws://localhost:3000/media-stream`
- **Admin Console & Call Simulator**: `http://localhost:3000/admin`

---

## 📞 Telephony Carrier Setup (Twilio & Exotel)

### Twilio
1. Expose your local port via ngrok or deploy to a public server:
   ```bash
   ngrok http 3000
   ```
2. In the **Twilio Console**, configure your active phone number:
   - **A CALL COMES IN**: Webhook
   - **URL**: `https://<YOUR_DOMAIN>/incoming-call`
   - **HTTP METHOD**: `POST`
3. When someone calls the phone number, Twilio executes the TwiML:
   ```xml
   <Response>
     <Connect>
       <Stream url="wss://<YOUR_DOMAIN>/media-stream"/>
     </Connect>
   </Response>
   ```

### Exotel
Configure the Voice Applet in Exotel's App Builder to connect to the WebSocket stream at `wss://<YOUR_DOMAIN>/media-stream`.

---

## 🧪 Testing & Verification

Run the automated test suites:

```bash
# 1. Test normalizer and SQLite operations
npx tsx test/test-pipeline.ts

# 2. Test live server endpoints, simulator flow, and WebSocket stream
npx tsx test/test-server.ts
```

### Web Call Tester
Visit `http://localhost:3000/admin` in your browser:
1. Click **Start Call** to initiate an inbound simulated cellular session.
2. Priya answers with her initial greeting.
3. Click or type: `"Looking for a ready 3 BHK at Mittal Palms around 1.8 Cr for self-use. Can we visit this Saturday with Raghavendra?"`
4. Watch Priya qualify the buyer and automatically sync the lead into **Google Sheets** and **SQLite**.
5. Click **⚡ Test Barge-In Clear** while audio is active to test sub-50ms carrier PBX buffer clearance.
6. Click **Hangup** to view the post-call AI summary and export leads to CSV.
