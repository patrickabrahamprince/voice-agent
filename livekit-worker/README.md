# Mittal Palms — LiveKit Voice Agent Worker

This directory contains the Python [LiveKit Agents](https://github.com/livekit/agents) worker for Mittal Palms.

## Features
- **Semantic Turn Detection**: Uses LiveKit's Transformer-based `TurnDetector()` to prevent interrupting callers mid-sentence.
- **Sarvam AI First-Party Voice**: Hindi and Indian English STT (Saaras), TTS (Bulbul - Kavya voice), and Sarvam 105B LLM.
- **WebRTC & Telephony SIP Bridge**: Compatible with LiveKit SIP to receive carrier phone calls directly into high-fidelity WebRTC rooms.
- **Direct Tool Calling**: Integrated `book_site_visit` tool to schedule walkthroughs with Raghavendra (9945577935).

## Running Locally

1. Create a Python 3.10+ virtual environment:
   ```bash
   python3 -m venv venv
   source venv/bin/activate
   pip install -r requirements.txt
   ```

2. Download turn-detector and VAD model weights:
   ```bash
   python -m livekit.agents download-files
   ```

3. Run in console mode (test with your computer microphone):
   ```bash
   python agent.py console
   ```

4. Run in LiveKit Cloud / Server mode:
   ```bash
   python agent.py dev
   ```
