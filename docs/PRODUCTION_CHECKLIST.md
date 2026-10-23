# 🚀 Production Telephony & Deployment Checklist (Plivo + Railway)

This checklist provides the exact end-to-end steps to launch the **Mittal Palms Real Estate Voice AI Agent** into live production with **Plivo** and **Railway**.

---

## 📋 1. Plivo Telephony Provisioning

### Step 1.1: Purchase an 080 Bangalore Number
1. Log in to the [Plivo Console](https://console.plivo.com).
2. Go to **Phone Numbers** ➔ **Buy Numbers** in the left sidebar.
3. Filter by:
   - **Country**: India (`+91`)
   - **Type**: Local (Fixed line)
   - **Prefix / City**: `80` (Bangalore)
4. Click **Buy** and complete billing checkout.
   > **Why 080?**: An authentic Bangalore landline (`080-XXXXXXXX`) gives maximum caller trust and pickup rates for Mittal Palms, Jakkur.

### Step 1.2: Create a Plivo XML Application
1. Go to **Voice** ➔ **XML Applications** ➔ click **Add New Application**.
2. Set **Application Name**: `Mittal Palms Voice AI`.
3. Configure the endpoints:
   - **Answer URL**:
     ```
     https://<YOUR-RAILWAY-DOMAIN>/incoming-call
     ```
     *(e.g., `https://getmoreos-production.up.railway.app/incoming-call`)*
   - **Answer Method**: `POST`
   - **Hangup URL**:
     ```
     https://<YOUR-RAILWAY-DOMAIN>/incoming-call
     ```
   - **Hangup Method**: `POST`
   - **Fallback URL**: Optional backup endpoint.
4. Click **Create Application**.

### Step 1.3: Link the Application to Your 080 Number
1. Go to **Phone Numbers** ➔ **Your Numbers**.
2. Click on the 080 Bangalore number you purchased.
3. In the **Application Type** dropdown, select **XML Application**.
4. In the **Plivo Application** dropdown, select **`Mittal Palms Voice AI`**.
5. Click **Update Number**.

---

## 🏛️ 2. TRAI DLT Compliance Registration (Mandatory for Indian Real Estate)

Under Telecom Regulatory Authority of India (TRAI) regulations, commercial entity communications (voice calls, SMS, WhatsApp follow-ups) require Distributed Ledger Technology (DLT) registration.

### Step 2.1: Principal Entity (PE) Registration
Register as a Business Entity on any of the telecom operator DLT portals (registration on one portal syncs across all operators in India):
* [Jio DLT Portal](https://trueconnect.jio.com)
* [Airtel DLT Portal](https://www.airtel.in/business/commercial-communication)
* [Vodafone Idea (Vilpower)](https://www.vilpower.in)
* [Tata Tele DLT (PingConnect)](https://telemarketer.tatateleservices.com)

**Required Documents**:
1. Company PAN Card (Mittal Developers / Agency).
2. GST Registration Certificate.
3. Certificate of Incorporation / Partnership Deed.
4. Authorized Signatory ID (Aadhaar/PAN) & Letter of Authorization.
5. Entity ID issued upon approval (starts with `1001...` or `1701...`).

### Step 2.2: Register Sender Headers (CLI / Sender ID)
1. In your DLT portal, navigate to **Headers** ➔ **Add Header**.
2. Select Category: **Real Estate / Construction**.
3. Header Type: **Transactional** or **Service Implicit**.
4. Header Name: 6 alphabetical characters (e.g., `MITTAL`, `MTLPAL`).

### Step 2.3: Content Template Registration (SMS / WhatsApp Follow-up)
Register your automated post-call lead confirmations and walkthrough invites:
* **Template Name**: `Mittal Palms Walkthrough Confirmation`
* **Template Type**: `Service Implicit`
* **Template Text**:
  ```
  Namaste {#var#}, thank you for speaking with Priya at Mittal Palms, Jakkur. Your walkthrough with Raghavendra is confirmed for {#var#}. Location: https://maps.app.goo.gl/... - MITTAL
  ```

### Step 2.4: Link DLT Entity ID to Plivo
Send your approved **DLT Entity ID** and **Registered Headers** to Plivo Support (`support@plivo.com` or via the Plivo Console Support Ticket) to associate your DLT registration with your Plivo account.

---

## 🚂 3. Deploying to Railway with Permanent Domain

### Step 3.1: Connect Repository to Railway
1. Go to [railway.app](https://railway.app) and click **New Project** ➔ **Deploy from GitHub repo**.
2. Select `patrickabrahamprince/voice-agent`.
3. Railway automatically detects the production [Dockerfile](file:///Users/mac/Voice%20Agent/Dockerfile) and [railway.json](file:///Users/mac/Voice%20Agent/railway.json).

### Step 3.2: Set Environment Variables in Railway
Under your Railway service **Variables** tab, add:

```env
PORT=3001
NODE_ENV=production
PUBLIC_DOMAIN=getmoreos-production.up.railway.app

# Telephony Provider (Plivo)
TELEPHONY_PROVIDER=plivo
PLIVO_AUTH_ID=MAMXXXXXXXXXXXXXXXXX
PLIVO_AUTH_TOKEN=your_plivo_auth_token_here
PLIVO_PHONE_NUMBER=+9180XXXXXXXX

# Voice AI Stack
SARVAM_API_KEY=your_sarvam_api_key_here
OPENROUTER_API_KEY=your_openrouter_api_key_here
LEAD_EMAIL=niraj@mittal.com

# Persistence (Service Account)
GOOGLE_SHEET_ID=your_sheet_id_here
GOOGLE_SERVICE_ACCOUNT_EMAIL=service-account@project.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

### Step 3.3: Generate Railway Domain
1. In Railway, go to **Settings** ➔ **Networking** ➔ **Public Networking**.
2. Click **Generate Domain**.
3. Copy the domain (e.g., `getmoreos-production.up.railway.app`).
4. Ensure `PUBLIC_DOMAIN` in your Railway Variables matches this domain!

---

## 🧪 4. Pre-Launch Production Verification

Run these verification tests against your live Railway domain:

### Test 1: Sub-100ms Health Check
```bash
curl -i https://getmoreos-production.up.railway.app/health
```
✅ **Expected Output (HTTP 200 within <50ms)**:
```json
{
  "status": "ok",
  "websocket": "wss://getmoreos-production.up.railway.app/media-stream",
  "provider": "plivo"
}
```

### Test 2: Voice XML Stream Webhook
```bash
curl -i -X POST https://getmoreos-production.up.railway.app/incoming-call
```
✅ **Expected Output (HTTP 200)**:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Stream bidirectional="true" streamTimeout="86400">wss://getmoreos-production.up.railway.app/media-stream</Stream>
</Response>
```

### Test 3: Dial the Real 080 Phone Number
1. From any Indian mobile phone (Airtel, Jio, Vi), dial your 080 number.
2. Verify:
   - Greeting plays within 1.5s in authentic Indian English via Sarvam Bulbul (`kavya`).
   - Voice questions regarding 2 BHK vs 3 BHK are answered by Sarvam 105B.
   - Walkthrough confirmation with Raghavendra (`9945577935`) is recorded.
   - Call record appears on live `/admin` dashboard and syncs to Google Sheets.
