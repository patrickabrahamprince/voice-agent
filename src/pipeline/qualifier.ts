import { sheetsService } from '../tools/sheets.js';
import { getCallerMemory, CallerMemoryContext } from '../tools/db.js';

export type ScriptStep =
  | 'GREETING_NAME'            // "Hi, good morning — am I speaking with [Name]?"
  | 'INTRO_EXPLORING_CHECK'    // "Hi, I’m Dylan Dsouza, a property advisor. I just wanted to check if you are exploring properties in Bangalore?"
  | 'ASK_REQUIREMENTS'         // "Great! May I know your requirements?"
  | 'ASK_PERMISSION'           // "I just need to ask a few quick questions to better understand your requirements — would that be alright?"
  | 'ASK_BHK'                  // "Are you looking for a 2 or 3 BHK?"
  | 'ASK_SIZE'                 // "Any particular size in mind?"
  | 'ASK_LOCATION'             // "And may I know which location you are most interested in?"
  | 'ASK_INTENT'               // "Is it for self-use or an investment?"
  | 'ASK_BUDGET'               // "May I know your budget?"
  | 'PROJECT_WALKTHROUGH'      // Thank you + project details walkthrough
  | 'WHATSAPP_FOLLOWUP_TIME'   // WhatsApp + Could we connect tomorrow?
  | 'CONFIRM_AND_CLOSING';     // Confirm time + Thank you, have an amazing day, goodbye!

export interface LeadQualificationState {
  callId: number | null;
  callerPhone: string;
  callerName: string;
  currentStep: ScriptStep;
  isExploringBangalore: boolean | null;
  config: '2 BHK' | '3 BHK' | null;
  sizeInMind: string | null;
  preferredLocation: string | null;
  intent: 'Self-use' | 'Investment' | null;
  budget: string | null;
  followUpTime: string | null;
  isQualified: boolean;
  leadQuality: 'Good Lead' | 'Bad Lead' | null;
  qualificationReason: string | null;
}

export class QualificationEngine {
  private state: LeadQualificationState;
  private memory: CallerMemoryContext;
  private persona: string = 'dylan';

  constructor(callId: number | null, callerPhone: string, persona: string = 'dylan') {
    this.memory = getCallerMemory(callerPhone);
    const existing = this.memory.existingLead;
    this.persona = persona;

    const existingName = existing?.callerName && existing.callerName !== 'Valued Buyer'
      ? existing.callerName
      : 'there';

    this.state = {
      callId,
      callerPhone,
      callerName: existingName,
      currentStep: 'GREETING_NAME',
      isExploringBangalore: null,
      config: existing?.config === '3 BHK' ? '3 BHK' : (existing?.config === '2 BHK' ? '2 BHK' : null),
      sizeInMind: null,
      preferredLocation: existing?.location || null,
      intent: existing?.intent === 'Investment' ? 'Investment' : (existing?.intent === 'Self-use' ? 'Self-use' : null),
      budget: existing?.budget || null,
      followUpTime: null,
      isQualified: false,
      leadQuality: null,
      qualificationReason: null,
    };
  }

  public setPersona(persona: string): void {
    this.persona = persona;
  }

  public getState(): LeadQualificationState {
    return { ...this.state };
  }

  /**
   * Step 1 of Script:
   * Advisor: "Hi, good morning — am I speaking with [Name]?"
   */
  public getGreeting(): string {
    const nameStr = this.state.callerName && this.state.callerName !== 'there' && this.state.callerName !== 'Valued Buyer'
      ? this.state.callerName
      : 'you';
    return `Hi, good morning — am I speaking with ${nameStr}?`;
  }

  public hydrateFromHistory(messages: { role: string; content?: string | null }[]): void {
    if (!messages || !Array.isArray(messages)) return;
    for (const msg of messages) {
      if (msg.role === 'user' && msg.content) {
        this.extractEntities(msg.content.toLowerCase());
      }
    }
  }

  /**
   * Main Utterance Handler: Follows Dylan Dsouza's exact script
   */
  public async handleUtterance(userUtterance: string): Promise<string> {
    const text = userUtterance.toLowerCase().trim();

    // 0. General Audio & Hold Handling
    if (text.includes('hear me') || text.includes('can you hear') || text.includes('are you there')) {
      return "Yes, I can hear you clearly! Please go ahead.";
    }
    if (text.includes('wait') || text.includes('hold on') || text.includes('one second')) {
      return "Sure, take your time! I'm right here.";
    }

    // 1. Direct Rejection / Not Interested
    if (text.includes('not interested') || text.includes('dont call') || text.includes("don't call") || text.includes('stop calling') || text.includes('wrong number')) {
      this.state.leadQuality = 'Bad Lead';
      this.state.isQualified = true;
      this.state.qualificationReason = 'Not interested in Bangalore properties';
      await this.syncLeadRecord();
      return "Understood! Thank you for your time. Have an amazing day. Goodbye!";
    }

    // 2. Direct FAQs (If caller asks questions at any point)
    if (text.includes('rate') || text.includes('price per sqft') || text.includes('cost per sqft') || text.includes('what is the price')) {
      return "The current rate for Trishul Mittal Palms is twelve thousand rupees per square foot, offering an exceptional value right by Jakkur Lake.";
    }
    if (text.includes('where is') || text.includes('location of') || text.includes('which area')) {
      return "Trishul Mittal Palms is located in Jakkur, Bangalore, built right beside Jakkur Lake and the Flying Club aerodrome, 6.5 km from Manyata Tech Park.";
    }

    // Extract any entities mentioned in the utterance
    this.extractEntities(text);

    // 3. Step-by-Step Script State Machine
    switch (this.state.currentStep) {
      case 'GREETING_NAME': {
        // Caller answered whether it's them: e.g. "Yes", "Speaking", "Who is this?", "No, my name is Amit"
        const nameMatch = text.match(/(?:my name is|this is|i am)\s+([a-z]+)/i);
        if (nameMatch && nameMatch[1]) {
          this.state.callerName = nameMatch[1].charAt(0).toUpperCase() + nameMatch[1].slice(1);
        }

        this.state.currentStep = 'INTRO_EXPLORING_CHECK';
        return "Hi, I’m Dylan Dsouza, a property advisor. I just wanted to check if you are exploring properties in Bangalore?";
      }

      case 'INTRO_EXPLORING_CHECK': {
        // Check if exploring properties in Bangalore
        const isNo = /^(no|nope|nah|not really|not looking|already bought)\b/i.test(text);
        if (isNo) {
          this.state.isExploringBangalore = false;
          this.state.leadQuality = 'Bad Lead';
          this.state.qualificationReason = 'Not exploring Bangalore properties';
          await this.syncLeadRecord();
          return "Understood! Thank you for your time. Have an amazing day. Goodbye!";
        }

        this.state.isExploringBangalore = true;
        this.state.currentStep = 'ASK_REQUIREMENTS';
        return "Great! May I know your requirements?";
      }

      case 'ASK_REQUIREMENTS': {
        // Caller mentions initial requirements: e.g. "Looking for 3 BHK", "Need something in North Bangalore"
        this.state.currentStep = 'ASK_PERMISSION';
        return "I just need to ask a few quick questions to better understand your requirements — would that be alright?";
      }

      case 'ASK_PERMISSION': {
        // Caller says "Sure", "Yes", "Go ahead", "Okay"
        if (!this.state.config) {
          this.state.currentStep = 'ASK_BHK';
          return "Are you looking for a 2 or 3 BHK?";
        }
        if (!this.state.sizeInMind) {
          this.state.currentStep = 'ASK_SIZE';
          return "Any particular size in mind?";
        }
        this.state.currentStep = 'ASK_LOCATION';
        return "And may I know which location you are most interested in?";
      }

      case 'ASK_BHK': {
        // Handled BHK extraction
        if (!this.state.sizeInMind) {
          this.state.currentStep = 'ASK_SIZE';
          return "Any particular size in mind?";
        }
        this.state.currentStep = 'ASK_LOCATION';
        return "And may I know which location you are most interested in?";
      }

      case 'ASK_SIZE': {
        this.state.currentStep = 'ASK_LOCATION';
        return "And may I know which location you are most interested in?";
      }

      case 'ASK_LOCATION': {
        this.state.currentStep = 'ASK_INTENT';
        return "Is it for self-use or an investment?";
      }

      case 'ASK_INTENT': {
        this.state.currentStep = 'ASK_BUDGET';
        return "May I know your budget?";
      }

      case 'ASK_BUDGET': {
        // Completed requirement gathering!
        this.state.currentStep = 'PROJECT_WALKTHROUGH';
        const projectWalkthrough =
          "Thank you so much for the information, sir. I'll quickly walk you through the project details. " +
          "This is an exclusive resale opportunity at Trishul Mittal Palms in Jakkur, Bangalore. " +
          "It is built right beside tranquil Jakkur Lake with uninterrupted scenic lake views, and directly behind the Jakkur Flying Club aerodrome. " +
          "We have ready 2 BHK residences from 1,235 to 1,340 square feet and 3 BHKs from 1,720 to 1,980 square feet with 3 large balconies at an attractive rate of twelve thousand rupees per square foot. " +
          "The gated community features massive open green spaces, a fully equipped clubhouse, swimming pool, gymnasium, sports area, 24/7 security, and 100% power backup. " +
          "I’ll share the complete details with you on WhatsApp so you can take a look at the floor plans. Could we connect tomorrow to discuss this further? Please let me know a suitable time for you.";
        
        this.state.currentStep = 'WHATSAPP_FOLLOWUP_TIME';
        return projectWalkthrough;
      }

      case 'WHATSAPP_FOLLOWUP_TIME': {
        // Caller specifies time: e.g. "Tomorrow at 11 AM", "After 4 PM", "Anytime evening"
        this.state.followUpTime = text;
        this.state.leadQuality = 'Good Lead';
        this.state.isQualified = true;
        this.state.qualificationReason = `Qualified buyer (${this.state.config || '2/3 BHK'}, Budget: ${this.state.budget || '₹12k/sqft'}). WhatsApp follow-up scheduled: "${text}".`;
        await this.syncLeadRecord();

        this.state.currentStep = 'CONFIRM_AND_CLOSING';
        return `Perfect, ${text} is confirmed! I've shared the complete floor plans on WhatsApp. Thank you for your time. Have an amazing day. Goodbye!`;
      }

      case 'CONFIRM_AND_CLOSING': {
        return "Thank you for your time. Have an amazing day. Goodbye!";
      }

      default:
        return "I'll share the complete details with you on WhatsApp so you can take a look at the floor plans. Could we connect tomorrow to discuss this further? Please let me know a suitable time for you.";
    }
  }

  private extractEntities(text: string): void {
    // 2 vs 3 BHK
    if (!this.state.config) {
      if (/\b(2\s*bhk|2bhk|two\s*bhk|2\s*bed|two\s*bed)\b/i.test(text)) {
        this.state.config = '2 BHK';
      } else if (/\b(3\s*bhk|3bhk|three\s*bhk|3\s*bed|three\s*bed)\b/i.test(text)) {
        this.state.config = '3 BHK';
      }
    }

    // Size
    if (!this.state.sizeInMind) {
      const sizeMatch = text.match(/([0-9,]+)\s*(?:sq\s*ft|sqft|square\s*feet|sft)/i);
      if (sizeMatch) {
        this.state.sizeInMind = `${sizeMatch[1]} sq.ft`;
      }
    }

    // Location
    if (!this.state.preferredLocation && this.state.currentStep === 'ASK_LOCATION') {
      this.state.preferredLocation = text;
    }

    // Intent (Self-use vs Investment)
    if (!this.state.intent) {
      if (text.includes('self') || text.includes('live') || text.includes('family') || text.includes('own')) {
        this.state.intent = 'Self-use';
      } else if (text.includes('invest') || text.includes('rent') || text.includes('roi')) {
        this.state.intent = 'Investment';
      }
    }

    // Budget
    if (!this.state.budget) {
      const budgetMatch = text.match(/(?:around|budget|under|upto|approx)?\s*([0-9.]+\s*(?:crore|cr|lakh|lakhs))/i);
      if (budgetMatch) {
        this.state.budget = budgetMatch[1];
      }
    }
  }

  public async syncLeadRecord(): Promise<void> {
    try {
      await sheetsService.qualifyAndSyncLead({
        call_id: this.state.callId,
        caller_name: this.state.callerName,
        phone_number: this.state.callerPhone,
        configuration: this.state.config || '2/3 BHK',
        location_preference: this.state.preferredLocation || 'Jakkur / North Bangalore',
        budget_bracket: this.state.budget || '₹12,000 / sqft',
        intent: this.state.intent || 'Self-use',
        possession_timeline: 'Ready to move',
        site_visit_day: this.state.followUpTime || 'Tomorrow WhatsApp follow-up',
        lead_quality: this.state.leadQuality || 'Good Lead',
        lead_status: this.state.followUpTime ? 'Good Lead - Follow-up Scheduled' : 'In Discussion',
        qualification_reason: this.state.qualificationReason || 'Trishul Mittal Palms inquiry with Dylan Dsouza',
      });
    } catch (err: any) {
      console.warn('[Qualifier] Lead sync notice:', err.message);
    }
  }
}
