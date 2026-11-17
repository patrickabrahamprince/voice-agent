import { sheetsService } from '../tools/sheets.js';
import { getCallerMemory, CallerMemoryContext } from '../tools/db.js';

export interface LeadQualificationState {
  callId: number | null;
  callerPhone: string;
  callerName: string;
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
  private persona: string = 'priya';

  constructor(callId: number | null, callerPhone: string, persona: string = 'priya') {
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
      config: null,
      sizeInMind: null,
      preferredLocation: 'Jakkur / North Bangalore',
      intent: null,
      budget: null,
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

  public hydrateFromHistory(messages: { role: string; content?: string | null }[]): void {
    if (!messages || !Array.isArray(messages)) return;
    for (const msg of messages) {
      if (msg.role === 'user' && msg.content) {
        this.extractEntities(msg.content.toLowerCase());
      }
    }
  }

  public extractEntities(text: string): void {
    const isNegation = /\b(never|not|no|don't|dont|didn't|didnt|wrong|neither|nor)\b/i.test(text);

    // If caller explicitly denies or corrects an assumed budget ("I never told you my budget is X", "that is not my budget")
    if (isNegation && (text.includes('budget') || text.includes('crore') || text.includes('cr') || text.includes('lakh'))) {
      this.state.budget = null;
      return;
    }

    // Caller Name
    const nameMatch = text.match(/(?:my name is|this is|i am|myself)\s+([a-z]+)/i);
    if (nameMatch && nameMatch[1] && !['looking', 'calling', 'interested', 'exploring', 'here', 'okay', 'fine', 'good'].includes(nameMatch[1].toLowerCase())) {
      this.state.callerName = nameMatch[1].charAt(0).toUpperCase() + nameMatch[1].slice(1).toLowerCase();
    }

    // 2 vs 3 BHK
    if (!this.state.config && !isNegation) {
      if (/\b(2\s*bhk|2bhk|two\s*bhk|2\s*bed|two\s*bed)\b/i.test(text)) {
        this.state.config = '2 BHK';
        this.state.isQualified = true;
      } else if (/\b(3\s*bhk|3bhk|three\s*bhk|3\s*bed|three\s*bed)\b/i.test(text)) {
        this.state.config = '3 BHK';
        this.state.isQualified = true;
      }
    }

    // Size
    if (!this.state.sizeInMind && !isNegation) {
      const sizeMatch = text.match(/([0-9,]+)\s*(?:sq\s*ft|sqft|square\s*feet|sft)/i);
      if (sizeMatch) {
        this.state.sizeInMind = `${sizeMatch[1]} sq.ft`;
      }
    }

    // Location
    if (text.includes('jakkur') || text.includes('hebbal') || text.includes('manyata') || text.includes('north bangalore') || text.includes('yelahanka')) {
      this.state.preferredLocation = 'Jakkur / North Bangalore';
    }

    // Intent (Self-use vs Investment)
    if (!this.state.intent && !isNegation) {
      if (text.includes('self') || text.includes('live') || text.includes('family') || text.includes('own') || text.includes('shifting')) {
        this.state.intent = 'Self-use';
      } else if (text.includes('invest') || text.includes('rent') || text.includes('roi') || text.includes('appreciation')) {
        this.state.intent = 'Investment';
      }
    }

    // Budget
    if (!this.state.budget && !isNegation) {
      const budgetMatch = text.match(/(?:around|budget|under|upto|approx)?\s*([0-9.]+\s*(?:crore|cr|lakh|lakhs))/i);
      if (budgetMatch) {
        this.state.budget = budgetMatch[1];
        this.state.isQualified = true;
      }
    }

    // Follow-up / Visit scheduling (only if caller is not delaying or objecting)
    const isVisitDelay = /\b(before|not yet|don't want|dont want|can't|cant|cannot|more info|details first)\b/i.test(text);
    if (!isVisitDelay && (text.includes('visit') || text.includes('tomorrow') || text.includes('saturday') || text.includes('sunday') || text.includes('weekend') || text.includes('am') || text.includes('pm'))) {
      const timeMatch = text.match(/\b(tomorrow|saturday|sunday|weekend|morning|afternoon|evening|\d{1,2}\s*(?:am|pm))\b/gi);
      if (timeMatch) {
        this.state.followUpTime = timeMatch.join(' ');
      }
    }

    // Lead quality assessment
    if (this.state.config || this.state.budget || this.state.followUpTime) {
      this.state.leadQuality = 'Good Lead';
      this.state.qualificationReason = `Inquired for Trishul Mittal Palms (${this.state.config || '2/3 BHK'}, Budget: ${this.state.budget || '₹12k/sqft'})`;
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
        site_visit_day: this.state.followUpTime || 'Site Visit / Follow-up',
        lead_quality: this.state.leadQuality || 'Good Lead',
        lead_status: this.state.followUpTime ? 'Good Lead - Visit Scheduled' : 'In Discussion',
        qualification_reason: this.state.qualificationReason || 'Trishul Mittal Palms inquiry with Priya',
      });
    } catch (err: any) {
      console.warn('[Qualifier] Lead sync notice:', err.message);
    }
  }
}
