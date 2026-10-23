# Getmore.OS Voice AI Production Deployment

## Live Production URLs (Render Singapore Edge)

| Service | Public URL | Description |
| :--- | :--- | :--- |
| **Admin Console & Web Tester** | [`https://mittal-palms-voice-agent.onrender.com/admin`](https://mittal-palms-voice-agent.onrender.com/admin) | Real-time audio tester, lead dashboard, & analytics |
| **Health Check Endpoint** | [`https://mittal-palms-voice-agent.onrender.com/health`](https://mittal-palms-voice-agent.onrender.com/health) | Sub-millisecond health status for monitoring |
| **Telephony Inbound Webhook** | `https://mittal-palms-voice-agent.onrender.com/incoming-call` | Plivo XML application Answer URL |
| **WebSocket Media Stream** | `wss://mittal-palms-voice-agent.onrender.com/media-stream` | Bidirectional 8kHz μ-law audio stream |

---

## Plivo Telephony Status (Configured & Live)

### 1. XML Application Details (Active)
| Parameter | Value |
| :--- | :--- |
| **Application Name** | `Mittal_Palms_Voice_AI` |
| **Application ID** | `32134225963323005` |
| **Default Number App** | `true` (Calls automatically route to this app) |
| **Primary Answer URL** | `https://mittal-palms-voice-agent.onrender.com/incoming-call` (POST) |
| **Hangup URL** | `https://mittal-palms-voice-agent.onrender.com/api/simulator/hangup` (POST) |
| **SIP URI** | `sip:32134225963323005@app.plivo.com` |
| **Bidirectional Stream** | `wss://mittal-palms-voice-agent.onrender.com/media-stream` |

### 2. Verified Credentials
- **Auth ID**: `MAMGM5NDZLOTETZDG4NY` (Verified on Render Singapore & Local)
- **Billing**: Active standard trial account (`Getmore OS`) with ₹12.50 cash credits

### 3. Number Provisioning & Live Call Flow
- **India Number KYC**: To assign an Indian DID (+91 80 or local mobile), Indian telecom regulations require business KYC submission on the [Plivo Phone Numbers Portal](https://cx.plivo.com/phone-numbers/list) (Business Incorporation Proof, Address, PAN).
- **SIP Calling**: Directly dialable over SIP via `sip:32134225963323005@app.plivo.com`
- **Call Handling**:
  1. Plivo answers in <300ms with Voice XML `<Stream>`
  2. Connects bidirectional 8kHz μ-law WebSocket stream
  3. Sarvam Bulbul v4-Flash (Kavya voice) delivers instant greeting with LRU cache acceleration
  4. Live audio & conversation stream to [Admin Console](https://mittal-palms-voice-agent.onrender.com/admin)
