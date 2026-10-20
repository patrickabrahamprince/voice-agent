import { sheetsService } from '../tools/sheets.js';
import { getCallerMemory, CallerMemoryContext } from '../tools/db.js';

export interface LeadQualificationState {
  callId: number | null;
  callerPhone: string;
  callerName: string;
  step: number;
  config: string | null;
  location: string | null;
  budget: string | null;
  intent: string | null;
  timeline: string | null;
  siteVisit: string | null;
  pitchDelivered: boolean;
  isQualified: boolean;
  leadQuality: 'Good Lead' | 'Bad Lead' | null;
  qualificationReason: string | null;
}

export class QualificationEngine {
  private state: LeadQualificationState;
  private memory: CallerMemoryContext;
  private persona: 'dylan' | 'priya' = 'dylan';

  constructor(callId: number | null, callerPhone: string, persona: 'dylan' | 'priya' = 'dylan') {
    this.memory = getCallerMemory(callerPhone);
    const existing = this.memory.existingLead;
    this.persona = persona;

    // Start fresh on each new call so prior call appointments don't cause infinite repetition
    this.state = {
      callId,
      callerPhone,
      callerName: existing?.callerName || 'Valued Buyer',
      step: 1,
      config: null,
      location: null,
      budget: null,
      intent: null,
      timeline: null,
      siteVisit: null,
      pitchDelivered: false,
      isQualified: false,
      leadQuality: null,
      qualificationReason: null,
    };
  }

  public setPersona(persona: 'dylan' | 'priya'): void {
    this.persona = persona;
  }

  public getState(): LeadQualificationState {
    return { ...this.state };
  }

  public getGreeting(): string {
    if (this.persona === 'dylan') {
      return "Hi, good morning — am I speaking with Rahul?";
    }
    if (this.memory.isReturningCaller) {
      const cfg = this.state.config ? ` our ${this.state.config}` : ' our ready homes';
      return `Hello! Welcome back to Mittal Palms. This is Priya. Wonderful to connect with you again! Are you looking to schedule a site walkthrough with Raghavendra for${cfg}, or can I help with floor plans?`;
    }
    return 'Hello! This is Priya from Mittal Palms in Jakkur. Thanks for calling! We have ready-to-move 2 and 3 BHK homes here. Are you looking for a 2 BHK or a 3 BHK for your family?';
  }

  /**
   * Hydrates in-call conversational state from full dialogue history.
   */
  public hydrateFromHistory(messages: { role: string; content?: string | null }[]): void {
    if (!messages || !Array.isArray(messages)) return;
    for (const msg of messages) {
      if (msg.role === 'user' && msg.content) {
        this.extractEntities(msg.content.toLowerCase());
      }
    }
  }

  /**
   * Evaluates caller utterance, handles objections/clarifications, and guides the qualification flow.
   */
  public async handleUtterance(userUtterance: string): Promise<string> {
    const text = userUtterance.toLowerCase().trim();

    // 0. CONVERSATIONAL CONFUSION & BARGE-IN REPAIR
    if (text.includes('hear me') || text.includes('can you hear') || text.includes('are you there')) {
      return "Yes, I can hear you clearly! Please go ahead.";
    }

    if (text.includes('wait') || text.includes('hold on') || text.includes('give me a second') || text.includes('let me answer') || text.includes('one second')) {
      return "Of course, take your time! I am listening.";
    }

    if (
      text.includes('not understand') ||
      text.includes("don't understand") ||
      text.includes('dont understand') ||
      text.includes('you are not') ||
      text.includes('misunderstood') ||
      text.includes('whats even this') ||
      text.includes('what is this') ||
      text.includes('listen to me') ||
      text.includes('listen')
    ) {
      return "I truly apologize for the misunderstanding! Please tell me what you're looking for or your question, and I will assist you right away.";
    }

    // Explicit Location Inquiry: Where is it located?
    if (text.includes('where is') || text.includes('where are') || text.includes('which location') || text.includes('what location') || text.includes('location of') || text.includes('where it is') || text.includes('address')) {
      return "Mittal Palms is located in Jakkur, North Bangalore, very close to Manyata Tech Park and Hebbal. At the moment, this is our exclusive project. Would that North Bangalore commute work for you?";
    }

    if (text.includes('whitefield') || text.includes('marathahalli') || text.includes('sarjapur') || text.includes('electronic city')) {
      return "Mittal Palms is located in Jakkur, North Bangalore, very close to Manyata Tech Park and Hebbal. At the moment, this is our exclusive project. Would that North Bangalore commute work for you?";
    }

    // 1. OBJECTION: Caller is Busy / Meeting / Driving
    if (
      text.includes('busy') ||
      text.includes('meeting') ||
      text.includes('driving') ||
      text.includes('call later') ||
      text.includes('cant talk') ||
      text.includes('cannot talk')
    ) {
      return "Completely understand! When would be a convenient time for me to give you a quick callback later today?";
    }

    // 2. OBJECTION: "Just send on WhatsApp" / "Don't call"
    if (
      text.includes('whatsapp') &&
      (text.includes('send') ||
        text.includes('brochure') ||
        text.includes('details') ||
        text.includes('dont call') ||
        text.includes("don't call"))
    ) {
      if (!this.state.config) {
        return "Absolutely! I will share the brochure on WhatsApp right away. Just to send the right floor plan, are you considering a 2 or 3 BHK?";
      }
      return "Got it! I am sending over the floor plans and brochure to your WhatsApp right now. When would be a good time tomorrow for a quick review?";
    }

    // 3. OBJECTION: Not interested / Not looking right now
    if (
      text.includes('not interested') ||
      text.includes('not looking') ||
      text.includes('no interest') ||
      text.includes('dont want') ||
      text.includes("don't want")
    ) {
      this.state.leadQuality = 'Bad Lead';
      this.state.isQualified = true;
      this.state.qualificationReason = 'Not looking currently';
      await this.syncLeadRecord();
      return "Understood, thank you for letting me know! Are you planning to explore something in the next 6 to 12 months, or should I take this off for now?";
    }

    // 4. OBJECTION: Where did you get my number?
    if (
      text.includes('where did you get') ||
      text.includes('who gave you') ||
      text.includes('how did you get') ||
      text.includes('source')
    ) {
      return "You had enquired regarding residential properties in Bangalore through an online portal. If this was by mistake, I can immediately update our records.";
    }

    // 5. OBJECTION: Hard Rejection / Do Not Call
    if (
      text.includes('remove my number') ||
      text.includes('do not call') ||
      text.includes('stop calling') ||
      text.includes('dont call again') ||
      text.includes("don't call again") ||
      text.includes('delete my number')
    ) {
      this.state.leadQuality = 'Bad Lead';
      this.state.isQualified = true;
      this.state.qualificationReason = 'DNC Requested';
      await this.syncLeadRecord();
      return "I truly apologize for any disturbance. I will mark your number on our Do Not Call list right away. Have a good day.";
    }

    // 6. OBJECTION: Villas / Plots only
    if (text.includes('villa') || text.includes('plot') || text.includes('independent house')) {
      return "Mittal Palms exclusively features premium ready-to-move 2 and 3 BHK apartments. We do not offer villas or plots at the moment.";
    }

    // 7. OBJECTION: Already booked / bought elsewhere
    if (text.includes('already bought') || text.includes('already booked') || text.includes('already purchased')) {
      return "Congratulations on your new home! Thank you so much for your time, and I wish you all the best.";
    }

    // 8. OBJECTION: Is price negotiable / discount
    if (text.includes('negotiable') || text.includes('discount') || text.includes('spot offer') || text.includes('reduce price')) {
      return "Our base pricing is standardized, but our relationship manager can walk you through unit-specific spot incentives during your walkthrough.";
    }

    // 9. OBJECTION: RERA & Bank Approvals
    if (text.includes('rera') || text.includes('approval') || text.includes('bank loan') || text.includes('sbi') || text.includes('hdfc')) {
      return "Yes, fully RERA approved with clear titles. Leading nationalized banks including SBI, HDFC, and ICICI have already approved up to 80% funding.";
    }

    // 10. OBJECTION: Ready to move vs Under construction / OC
    if (text.includes('ready to move') || text.includes('oc') || text.includes('possession') || text.includes('occupancy')) {
      return "That is smart. This development is 100% ready-to-move with full Occupancy Certificate in hand, so there is zero construction risk.";
    }

    // 11. Disqualify: Rental or non-buyer
    if (text.includes('rent') || text.includes('pg') || text.includes('broker') || text.includes('commercial')) {
      this.state.leadQuality = 'Bad Lead';
      this.state.isQualified = true;
      this.state.qualificationReason = 'Rental / Non-buyer inquiry';
      await this.syncLeadRecord();
      return 'Understood! We exclusively assist home buyers with residential property purchases. Let us know if your family ever plans to buy a home in Bangalore!';
    }

    // 12. If already qualified and user speaks again (DO NOT repeat walkthrough message in a loop!)
    if (this.state.isQualified) {
      if (text.includes('thank') || text.includes('ok') || text.includes('bye') || text.includes('sure') || text.includes('fine')) {
        return "Thank you so much for your time! Have an amazing day ahead. Goodbye!";
      }
      return "Understood! I've noted that down. We'll share the complete floor plans and details with you on WhatsApp. Is there anything else I can help with?";
    }

    // Extract entities
    this.extractEntities(text);

    // =========================================================================
    // SCRIPT QUALIFICATION STAGES (Matching CONVERSATION.md)
    // =========================================================================

    // Stage 1 Greeting response
    if (this.state.step === 1 && !this.state.config) {
      if (text.includes('yes') || text.includes('speaking') || text.includes('this is') || text.includes('who is') || text.includes('rahul') || text.includes('hi') || text.includes('hello')) {
        this.state.step = 2;
        return "Hi, I’m Dylan Dsouza, a property advisor. I just wanted to check if you are exploring properties in Bangalore?";
      }
    }

    // Stage 2 Intro Hook response
    if (this.state.step === 2 && !this.state.config) {
      if (text.includes('yes') || text.includes('looking') || text.includes('searching') || text.includes('exploring') || text.includes('yeah') || text.includes('maybe') || text.includes('i am') || text.includes('swayam')) {
        this.state.step = 3;
        return "Great! I just need to ask a few quick questions to better understand your requirements — would that be alright?";
      }
    }

    // Stage 3 Permission response
    if (this.state.step === 3 && !this.state.config) {
      if (text.includes('yes') || text.includes('sure') || text.includes('alright') || text.includes('ok') || text.includes('go ahead') || text.includes('ask')) {
        this.state.step = 4;
        return "Are you looking for a 2 or 3 BHK?";
      }
    }

    // Question 1: Configuration (2 vs 3 BHK) - Mittal Palms offers only 2 & 3 BHK in Jakkur
    const has3Bhk = /\b(3\s*bhk|3bhk|three\s*bhk|three\s*bedroom|3\s*bedroom|three|3\s*ways)\b/i.test(text) &&
      !text.includes('crore') && !text.includes('cr') && !text.includes('lakh');
    const has2Bhk = /\b(2\s*bhk|2bhk|two\s*bhk|two\s*bedroom|2\s*bedroom|two)\b/i.test(text) &&
      !text.includes('crore') && !text.includes('cr') && !text.includes('lakh');

    if (has2Bhk) {
      this.state.config = '2 BHK';
      this.state.location = 'Jakkur, North Bangalore';
    } else if (has3Bhk) {
      this.state.config = '3 BHK';
      this.state.location = 'Jakkur, North Bangalore';
    }

    if (!this.state.config) {
      return "Are you looking for a 2 or 3 BHK?";
    }

    // Single Exclusive Project Scope: Location is always locked to Mittal Palms, Jakkur
    this.state.location = 'Jakkur, North Bangalore';

    // Question 2: Intent & Purpose (Self-use vs Investment)
    if (!this.state.intent) {
      if (text.includes('self') || text.includes('own') || text.includes('family') || text.includes('live') || text.includes('moving')) {
        this.state.intent = 'Self-use';
      } else if (text.includes('invest') || text.includes('rental') || text.includes('yield') || text.includes('roi')) {
        this.state.intent = 'Investment';
      } else {
        return "Makes complete sense! Is it for self-use or an investment?";
      }
    }

    // Question 4: Budget
    if (!this.state.budget) {
      const budgetMatch = this.extractBudget(text);
      if (budgetMatch) {
        this.state.budget = budgetMatch;
      } else {
        return "And may I know your budget?";
      }
    }

    // Check severe budget mismatch
    if (this.detectSevereBudgetMismatch(this.state.budget || '')) {
      this.state.leadQuality = 'Bad Lead';
      this.state.isQualified = true;
      this.state.qualificationReason = `Budget mismatch: ${this.state.budget} is below ready 2/3 BHK pricing for Mittal Palms.`;
      await this.syncLeadRecord();
      return "Understood! At Mittal Palms, our ready-to-move 2 and 3 BHK residences start from 1.25 Crore onwards. If your budget expands in the future, we'd be delighted to assist.";
    }

    // Stage 5: Pitch & Booking Callback / Walkthrough with Raghavendra (9945577935)
    if (!this.state.pitchDelivered) {
      this.state.pitchDelivered = true;
      return "Thank you so much for the information! Mittal Palms is spread across 3.2 acres in Jakkur, offering ready-to-move 2 and 3 BHK residences with a clubhouse and landscaped gardens. I’ll share the complete floor plans with you on WhatsApp so you can take a look. Could we connect tomorrow to discuss this further? Please let me know a suitable time for you.";
    }

    // After pitch has already been delivered:
    // If the caller clarifies/corrects: "but I asked for 2 BHK" or "looking for 2 BHK"
    if (text.includes('2 bhk') || text.includes('2bhk') || text.includes('two') || text.includes('2')) {
      this.state.config = '2 BHK';
      return "Got it, 2 BHK! My apologies. For our ready 2 BHKs at Mittal Palms, we have 1235 to 1340 square feet starting around 1.25 Crore. Could we connect tomorrow for a walkthrough?";
    }

    if (text.includes('3 bhk') || text.includes('3bhk') || text.includes('three') || text.includes('3')) {
      this.state.config = '3 BHK';
      return "Got it, 3 BHK! For our ready 3 BHKs at Mittal Palms, we have 1750 to 1980 square feet starting around 1.7 Crore. Could we connect tomorrow for a walkthrough?";
    }

    // If caller agreed or gave a time: "okay", "sure", "tomorrow", "yes", "weekend", "pm", "am", etc.
    const isAgreeing =
      text.includes('ok') ||
      text.includes('sure') ||
      text.includes('yes') ||
      text.includes('yeah') ||
      text.includes('fine') ||
      text.includes('tomorrow') ||
      text.includes('weekend') ||
      text.includes('saturday') ||
      text.includes('sunday') ||
      text.includes('morning') ||
      text.includes('afternoon') ||
      text.includes('evening') ||
      text.includes('pm') ||
      text.includes('am') ||
      text.includes('time') ||
      text.includes('call') ||
      text.includes('connect');

    if (isAgreeing) {
      this.state.siteVisit = 'Site Walkthrough Booked with Raghavendra';
      this.state.leadQuality = 'Good Lead';
      this.state.isQualified = true;
      this.state.qualificationReason = `Qualified buyer (${this.state.config}) for Mittal Palms, Jakkur. Budget: ${this.state.budget}, Intent: ${this.state.intent}. Walkthrough booked with Raghavendra (9945577935). Registered to niraj@mittal.com.`;
      await this.syncLeadRecord();
      return "Understood, that time is noted! I’ll send the floor plans over WhatsApp right away. Thank you for your time. Have an amazing day. Goodbye!";
    }

    return "Understood! I'll share the complete brochure and pricing details on WhatsApp right away. When would be a good time tomorrow for Raghavendra to assist you?";
  }

  private extractEntities(text: string): void {
    if (!this.state.config) {
      if (text.includes('2 bhk') || text.includes('2bhk')) this.state.config = '2 BHK';
      else if (text.includes('3 bhk') || text.includes('3bhk')) this.state.config = '3 BHK';
    }

    if (!this.state.budget) {
      const b = this.extractBudget(text);
      if (b) this.state.budget = b;
    }

    if (!this.state.intent) {
      if (text.includes('self') || text.includes('own') || text.includes('live') || text.includes('family')) this.state.intent = 'Self-use';
      else if (text.includes('invest') || text.includes('yield')) this.state.intent = 'Investment';
    }

    if (!this.state.location) {
      if (text.includes('jakkur') || text.includes('hebbal') || text.includes('manyata') || text.includes('north') || text.includes('airport') || text.includes('yelahanka')) {
        this.state.location = 'Jakkur, North Bangalore';
      }
    }
  }

  private extractBudget(text: string): string | null {
    // Strip out BHK and bedroom references first so "2 BHK" or "3 BHK" never falsely matches budget numbers!
    const clean = text.replace(/\b[1-5]\s*bhk\b/gi, '').replace(/\b[1-5]\s*bedroom\b/gi, '').trim();
    if (!clean) return null;

    if (/\b(2(?:\.0|\.1)?|2\s*cr|2\s*crore|1\.8|1\.9|two\s*cr)\b/i.test(clean)) return '1.8 to 2.1 Crore rupees';
    if (/\b(1\.5|1\.6|1\.7|one\s*point\s*five)\b/i.test(clean)) return '1.5 to 1.8 Crore rupees';
    if (/\b(1\.2|1\.3|1\.4|1\.1|1\s*cr|1\s*crore|one\s*cr|one\s*crore)\b/i.test(clean)) return '1.15 to 1.35 Crore rupees';
    if (/\b(80|85|90)\s*(?:l|lakh|lakhs)?\b/i.test(clean)) return '80 to 90 Lakhs';
    if (/\b(40|35|30|under\s*50)\b/i.test(clean)) return 'Under 40 Lakhs';
    if (clean.includes('crore') || clean.includes('cr')) return '1.25 to 1.95 Crore rupees';
    return null;
  }

  private detectSevereBudgetMismatch(text: string): boolean {
    return text.includes('35') || text.includes('30') || text.includes('25') || text.includes('40 lakhs') || text.includes('under 50');
  }

  private async syncLeadRecord(): Promise<void> {
    try {
      if (this.state.isQualified && this.state.leadQuality) {
        await sheetsService.qualifyAndSyncLead({
          call_id: this.state.callId,
          caller_name: this.state.callerName,
          phone_number: this.state.callerPhone,
          configuration: this.state.config || '2 or 3 BHK',
          location_preference: this.state.location || 'Jakkur, North Bangalore',
          budget_bracket: this.state.budget || '1.25 - 1.95 Cr',
          intent: this.state.intent || 'Self-use',
          possession_timeline: this.state.timeline || 'Immediate (Ready to Move)',
          site_visit_day: this.state.siteVisit || 'Walkthrough with Raghavendra (9945577935)',
          lead_quality: this.state.leadQuality,
          lead_status: this.state.leadQuality === 'Good Lead' ? 'Good Lead - Hot (Walkthrough Booked)' : 'Bad Lead - Disqualified',
          qualification_reason: this.state.qualificationReason || 'Mittal Palms qualification complete. Registered to niraj@mittal.com.',
          lead_email: 'niraj@mittal.com',
        });
      }
    } catch (err: any) {
      console.warn('[Qualifier] Lead sync warning:', err.message);
    }
  }
}
