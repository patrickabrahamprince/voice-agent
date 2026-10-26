"""
Mittal Palms Voice Agent — LiveKit Agents Worker
Implements real-time WebRTC and LiveKit SIP telephony integration with:
- Semantic Turn Detection (prevents cutting off callers mid-hesitation)
- Sarvam AI Saaras (STT), Bulbul (TTS), and Sarvam 105B / Groq (LLM)
- Field-tested Priya Mittal Palms Property Advisor Persona
"""

import os
from dotenv import load_dotenv
from livekit.agents import (
    Agent,
    AgentServer,
    AgentSession,
    JobContext,
    RunContext,
    cli,
    function_tool,
)
from livekit.agents.inference import TurnDetector
from livekit.plugins import sarvam, silero, groq, openai

load_dotenv()

PRIYA_INSTRUCTIONS = """You are Priya, a warm, professional, and courteous senior property advisor representing Mittal Palms in Jakkur, North Bangalore.
You are speaking live over an audio voice call.

PROJECT OVERVIEW:
- Project: Mittal Palms in Jakkur, Bangalore (right beside tranquil Jakkur Lake, 6.5 km to Manyata Tech Park).
- Status: 100% Ready-to-move-in with Occupancy Certificate (OC) received. Immediate handover.
- Pricing:
  * 2 BHK (1,235 to 1,340 sqft): Starts at 1.25 to 1.35 Crore rupees (₹12,000 per sqft).
  * 3 BHK (1,720 to 1,980 sqft): Starts at 1.7 to 1.95 Crore rupees (₹12,000 per sqft).
- Zero GST on ready resale homes.
- Relationship Manager: Raghavendra (9945577935) available for site visits.

CRITICAL VOICE PHONE RULES:
1. BREVITY: Keep every turn strictly 1 to 2 short sentences (under 25 words).
2. NEVER ASSUME BUDGET: Never state or guess a caller's budget unless they explicitly state it first.
3. NEGATION HANDLING: If the caller says "I never said that", immediately apologize in one short sentence and ask their actual preference.
4. PHONETIC NUMBERS: Spell out numbers ("one point two five crore rupees", "twelve thousand rupees per square foot").
"""

@function_tool
async def book_site_visit(
    context: RunContext,
    day_and_time: str,
    configuration: str = "2 or 3 BHK",
):
    """Book a preview site walkthrough at Mittal Palms with relationship manager Raghavendra."""
    return {
        "status": "confirmed",
        "day_and_time": day_and_time,
        "manager": "Raghavendra",
        "phone": "9945577935",
        "message": f"Site visit reserved for {day_and_time}. Raghavendra will welcome the buyer at the gate."
    }

server = AgentServer()

@server.rtc_session()
async def entrypoint(ctx: JobContext):
    # Determine model availability
    sarvam_key = os.getenv("SARVAM_API_KEY")
    groq_key = os.getenv("GROQ_API_KEY")

    # Speech-to-Text: Sarvam Saaras v3
    stt_engine = sarvam.STT(language_code="hi-IN") if sarvam_key else openai.STT()

    # LLM Engine: Sarvam 105B or Groq Qwen
    if groq_key:
        llm_engine = groq.LLM(model="qwen/qwen3.8-27b")
    elif sarvam_key:
        llm_engine = sarvam.LLM(model="sarvam-105b")
    else:
        llm_engine = openai.LLM(model="gpt-4o-mini")

    # Text-to-Speech: Sarvam Bulbul (Kavya voice)
    tts_engine = sarvam.TTS(voice="kavya") if sarvam_key else openai.TTS(voice="alloy")

    session = AgentSession(
        vad=silero.VAD.load(),
        turn_detection=TurnDetector(),
        stt=stt_engine,
        llm=llm_engine,
        tts=tts_engine,
    )

    priya_agent = Agent(
        instructions=PRIYA_INSTRUCTIONS,
        tools=[book_site_visit],
    )

    await session.start(agent=priya_agent, room=ctx.room)

    # Initial Priya Greeting
    await session.generate_reply(
        instructions="Greet the caller warmly from Mittal Palms in Jakkur, announce ready-to-move 2 and 3 BHK units with OC, and ask if they are looking for a 2 BHK or a 3 BHK for their family."
    )

if __name__ == "__main__":
    cli.run_app(server)
