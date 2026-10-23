# Getmore.OS Voice AI Production Deployment

## Live Production URLs (Render Singapore Edge)

| Service | Public URL | Description |
| :--- | :--- | :--- |
| **Admin Console & Web Tester** | [`https://mittal-palms-voice-agent.onrender.com/admin`](https://mittal-palms-voice-agent.onrender.com/admin) | Real-time audio tester, lead dashboard, & analytics |
| **Health Check Endpoint** | [`https://mittal-palms-voice-agent.onrender.com/health`](https://mittal-palms-voice-agent.onrender.com/health) | Sub-millisecond health status for monitoring |
| **Telephony Inbound Webhook** | `https://mittal-palms-voice-agent.onrender.com/incoming-call` | Plivo XML application Answer URL |
| **WebSocket Media Stream** | `wss://mittal-palms-voice-agent.onrender.com/media-stream` | Bidirectional 8kHz μ-law audio stream |

---

## Plivo Telephony Setup (3-Step Checklist)

### 1. Create XML Application in Plivo Console
1. Go to **[Plivo Console -> Voice -> XML Applications](https://console.plivo.com/voice/applications/)**
2. Click **Add New Application**
3. Set **Application Name**: `Mittal Palms Voice AI`
4. Set **Primary Answer URL**: `https://mittal-palms-voice-agent.onrender.com/incoming-call`
5. Set **HTTP Method**: `POST`
6. Set **Hangup URL**: `https://mittal-palms-voice-agent.onrender.com/api/simulator/hangup`
7. Click **Create Application**

### 2. Link Bangalore Phone Number
1. In **[Plivo Console -> Numbers](https://console.plivo.com/phone-numbers/)**, select your rented number (`080` Bangalore DID or mobile).
2. Under **Application Type**, select **XML Application**.
3. In **Plivo Application**, select `Mittal Palms Voice AI`.
4. Click **Update Number**.

### 3. Verify Live Call Flow
Dial your Plivo number from any phone.
- **Answered in <300ms** by Plivo Voice XML
- **Media Stream connects** to `wss://mittal-palms-voice-agent.onrender.com/media-stream`
- **Priya greets caller**: *"Hello! Thank you for calling Mittal Palms in Jakkur. This is Priya from the sales lounge..."*
- **Live transcript & audio** stream in real time to the [Admin Console](https://mittal-palms-voice-agent.onrender.com/admin).
