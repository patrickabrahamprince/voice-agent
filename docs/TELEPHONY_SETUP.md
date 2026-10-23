# 📞 Exotel Telephony Provisioning & Setup Guide

This guide details how to link an **Exotel Indian Virtual Phone Number (ExoPhone)** to the Mittal Palms Voice AI Agent for TRAI/DoT-compliant inbound voice calls.

---

## 🏗️ How Exotel Connects to the Voice Agent

```
Caller (+91 Mobile) 
       │
       ▼ (Cellular Call)
Exotel Telecom Gateway (Bangalore / Mumbai)
       │
       ├─► 1. POST https://<PUBLIC_DOMAIN>/incoming-call
       │      Server responds with Voice XML:
       │      <Response><Connect><Stream url="wss://<PUBLIC_DOMAIN>/media-stream"/></Connect></Response>
       │
       └─► 2. Bidirectional WebSocket (8kHz G.711 μ-law)
              wss://<PUBLIC_DOMAIN>/media-stream
              ├── Voice In  : Caller audio ➔ Energy VAD ➔ Sarvam Saaras v3 STT
              ├── Reasoning : Sarvam AI 105B Conversations (Priya Persona)
              └── Voice Out : Sarvam Bulbul v3 (Kavya 8k μ-law) ➔ Caller Ear
```

---

## 📋 Step 1: Claim or Purchase an ExoPhone (Exotel Console)

1. Log into your **Exotel Dashboard** at [my.exotel.com](https://my.exotel.com).
2. Navigate to **ExoPhones** (left sidebar under **Phone Numbers**).
3. Click **Buy a Number** / **Add ExoPhone**.
4. Select your preferred configuration:
   - **Country**: India (`+91`)
   - **Type**: Local Landline (e.g., `080` for Bangalore) or Mobile Virtual DID (`+91-XXXXXXXXXX`).
   - *Note for Indian Real Estate*: An `080` Bangalore number gives highest caller trust for Mittal Palms, Jakkur.
5. Complete payment and assign the number to your account.

---

## ⚙️ Step 2: Configure the Call Flow & Webhook

Exotel uses **Applets (Call Flows)** to control what happens when someone calls your ExoPhone.

1. In the Exotel Dashboard, go to **App Bazaar** ➔ **Create App** (or edit your existing flow).
2. Name the app: `Mittal Palms Voice AI`.
3. Add a **Voice Stream / Passthru Applet** to the start of the flow:
   - **Applet Type**: `Connect Applet` / `Voice Stream Applet` (or `Passthru Applet`).
   - **HTTP Method**: `POST`
   - **URL**:
     ```
     https://<PUBLIC_DOMAIN>/incoming-call
     ```
     *(Example: `https://harbour-inputs-troubleshooting-com.trycloudflare.com/incoming-call`)*
4. If configuring directly via **Voice Streaming Applet**:
   - **WebSocket Stream URL**:
     ```
     wss://<PUBLIC_DOMAIN>/media-stream
     ```
   - **Audio Format**: `G.711 μ-law (8kHz)`
5. Click **Save** and **Publish Applet**.

---

## 🔗 Step 3: Attach the Call Flow to Your ExoPhone

1. Go back to **ExoPhones** in your dashboard.
2. Locate the phone number you purchased in Step 1.
3. In the **Installed App** dropdown next to that number, select **`Mittal Palms Voice AI`**.
4. Click **Save Changes**.

---

## 🔑 Step 4: Configure Credentials in `.env`

In your server's `.env` file, populate your Exotel credentials found under **Dashboard Settings ➔ API Credentials**:

```env
# Public Host Domain (Must be publicly accessible via HTTPS / WSS)
PUBLIC_DOMAIN=harbour-inputs-troubleshooting-com.trycloudflare.com

# Exotel Credentials
TELEPHONY_PROVIDER=exotel
EXOTEL_SID=your_exotel_subdomain_or_sid
EXOTEL_API_KEY=your_exotel_api_key
EXOTEL_API_TOKEN=your_exotel_api_token
EXOTEL_PHONE_NUMBER=+9180XXXXXXXX
```

---

## 🧪 Step 5: Test with a Real Cellular Call

### 1. Verify Endpoint Health Before Dialing:
Run a quick health check from your terminal:
```bash
curl -s https://<PUBLIC_DOMAIN>/health | jq
```
Expected output:
```json
{
  "status": "ok",
  "websocket": "wss://<PUBLIC_DOMAIN>/media-stream",
  "provider": "exotel"
}
```

### 2. Verify Webhook XML Output:
```bash
curl -s -X POST https://<PUBLIC_DOMAIN>/incoming-call
```
Expected response:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://<PUBLIC_DOMAIN>/media-stream"/>
  </Connect>
</Response>
```

### 3. Place a Real Cellular Call:
1. From your mobile phone, dial your **ExoPhone number** (`+91...`).
2. **What You Should Hear Within 1.5s**:
   > *"Hello! This is Priya from Mittal Palms in Jakkur. Thanks for calling! We have ready-to-move 2 and 3 BHK homes here with Occupancy Certificate received. Are you looking for a 2 BHK or a 3 BHK for your family?"*
3. **Test Conversational Turns**:
   - Ask: *"What is the starting price for a 3 BHK?"*
   - Priya answers: Starts from ~₹1.70 Cr all-inclusive, OC received.
   - Say: *"Can I visit this Saturday at 11 AM?"*
   - Priya answers: Confirms 11 AM walkthrough with Raghavendra (`9945577935`) and offers brochure over WhatsApp.
4. **Test Barge-In / Interruption**:
   - Speak while Priya is mid-sentence.
   - Priya stops speaking immediately (<50ms buffer flush) and listens to your new statement.
5. **Verify Post-Call Sync**:
   - Hang up.
   - Check the **Admin Dashboard** at `https://<PUBLIC_DOMAIN>/admin` to see the complete audio transcript, duration, and qualified lead row.
   - Check Google Sheets for the appended lead record.

---

## ⚠️ Important Hosting Note (Vercel vs Persistent Server)

> [!WARNING]
> **Vercel Serverless Functions DO NOT support persistent WebSockets.**  
> If Exotel connects to a Vercel-hosted URL, the WebSocket (`/media-stream`) will drop immediately with error `1006 Connection Abnormal`.  
> For live cellular telephony, always run your server on:
> 1. A persistent VM or container (Railway, Render, AWS EC2, or Docker).
> 2. A Cloudflare Tunnel (`cloudflared tunnel --url http://localhost:3001`).
