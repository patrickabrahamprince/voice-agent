import { sheetsService } from '../tools/sheets.js';
import { getCallerMemory, CallerMemoryContext } from '../tools/db.js';

export interface LeadQualificationState {
  callId: number | null;
  callerPhone: string;
  callerName: string;
  config: '2 BHK' | '3 BHK' | null;
  location: string;
  budget: string | null;
  intent: string | null;
  siteVisit: string | null;
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

    this.state = {
      callId,
      callerPhone,
      callerName: existing?.callerName || 'Valued Buyer',
      config: existing?.config === '3 BHK' ? '3 BHK' : (existing?.config === '2 BHK' ? '2 BHK' : null),
      location: 'Mittal Palms, Jakkur, North Bangalore',
      budget: existing?.budget || null,
      intent: existing?.intent || null,
      siteVisit: null,
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

  public getGreeting(): string {
    const agent = 'Priya';
    if (this.memory.isReturningCaller) {
      const cfg = this.state.config ? ` our ${this.state.config}` : ' our ready homes';
      return `Hello! Welcome back to Mittal Palms. This is ${agent}. Wonderful to connect with you again! Are you looking to schedule your walkthrough with Raghavendra for${cfg}, or can I assist with floor plans?`;
    }
    return `Hello! This is ${agent} from Mittal Palms in Jakkur. We have ready-to-move 2 and 3 BHK homes with Occupancy Certificate received. Are you looking for a 2 BHK or a 3 BHK for your family?`;
  }

  public hydrateFromHistory(messages: { role: string; content?: string | null }[]): void {
    if (!messages || !Array.isArray(messages)) return;
    for (const msg of messages) {
      if (msg.role === 'user' && msg.content) {
        this.extractEntities(msg.content.toLowerCase());
      }
    }
  }

  public async handleUtterance(userUtterance: string): Promise<string> {
    const text = userUtterance.toLowerCase().trim();

    // 0. Audio check / repair
    if (text.includes('hear me') || text.includes('can you hear') || text.includes('are you there')) {
      return "Yes, I can hear you clearly! Please go ahead.";
    }

    if (text.includes('wait') || text.includes('hold on') || text.includes('one second') || text.includes('give me a moment')) {
      return "Of course, take your time! I am right here.";
    }

    // 1. Objections
    // Busy / callback
    if (text.includes('busy') || text.includes('in a meeting') || text.includes('driving') || text.includes('call later') || text.includes('cant talk') || text.includes('cannot talk')) {
      return "Completely understand! When would be a convenient time for Raghavendra or me to give you a quick callback?";
    }

    // Send on WhatsApp
    if (text.includes('whatsapp') || text.includes('brochure') || text.includes('send details') || text.includes('floor plan')) {
      this.extractEntities(text);
      if (!this.state.config) {
        return "Absolutely! I will share the brochure and floor plans on WhatsApp right away. Are you considering our 2 or 3 BHK?";
      }
      return `Got it! I am sending over our ${this.state.config} floor plans and pricing to your WhatsApp right now. When would be a good time for a walkthrough?`;
    }

    // Hard rejection / Do not call
    if (text.includes('remove my number') || text.includes('do not call') || text.includes('stop calling') || text.includes('dont call') || text.includes("don't call")) {
      this.state.leadQuality = 'Bad Lead';
      this.state.isQualified = true;
      this.state.qualificationReason = 'DNC Requested';
      await this.syncLeadRecord();
      return "I apologize for any disturbance. I will remove your number from our records right away. Have a good day.";
    }

    // Not interested
    if (text.includes('not interested') || text.includes('not looking') || text.includes('wrong number')) {
      this.state.leadQuality = 'Bad Lead';
      this.state.isQualified = true;
      this.state.qualificationReason = 'Not interested';
      await this.syncLeadRecord();
      return "Understood, thank you for letting us know! Have a wonderful day ahead.";
    }

    // Rental / non-buyer
    if (text.includes('rent') || text.includes('lease') || text.includes('pg') || text.includes('commercial')) {
      this.state.leadQuality = 'Bad Lead';
      this.state.isQualified = true;
      this.state.qualificationReason = 'Rental / Non-buyer';
      await this.syncLeadRecord();
      return "Mittal Palms exclusively offers residential homes for purchase. Please let us know if you ever look to buy a home in Bangalore!";
    }

    // Villas / plots
    if (text.includes('villa') || text.includes('plot') || text.includes('land only')) {
      return "Mittal Palms exclusively features ready-to-move 2 and 3 BHK luxury residences. We do not offer villas or plots here.";
    }

    // Other micro-markets (Whitefield, Sarjapur, Electronic City, etc.)
    if (text.includes('whitefield') || text.includes('sarjapur') || text.includes('electronic city') || text.includes('kanakapura')) {
      return "Mittal Palms is located in Jakkur, North Bangalore, right near Manyata Tech Park and Hebbal. This is our only project. Does that commute work for you?";
    }

    // 2. Direct Mittal Palms project FAQs
    // Price inquiries
    if (text.includes('price') || text.includes('cost') || text.includes('how much') || text.includes('budget') || text.includes('rate') || text.includes('quotation')) {
      this.extractEntities(text);
      if (this.state.config === '2 BHK') {
        return "Our ready 2 BHKs at Mittal Palms start from 1.25 to 1.35 Crore rupees all-inclusive. Would you like to schedule a walkthrough to view the model flat?";
      }
      if (this.state.config === '3 BHK') {
        return "Our ready 3 BHKs at Mittal Palms start from 1.7 to 1.95 Crore rupees all-inclusive. Would you like to schedule a walkthrough to view the residence?";
      }
      return "At Mittal Palms, our ready 2 BHKs start from 1.25 to 1.35 Crore rupees, and 3 BHKs start from 1.7 to 1.95 Crore rupees all-inclusive. Which configuration fits your family?";
    }

    // OC / Ready to Move status
    if (text.includes('oc') || text.includes('occupancy') || text.includes('ready to move') || text.includes('possession') || text.includes('handover') || text.includes('under construction')) {
      return "Yes, Mittal Palms is 100% ready to move in with Occupancy Certificate received and immediate handover. Zero construction wait!";
    }

    // Location / Address
    if (text.includes('location') || text.includes('where is') || text.includes('address') || text.includes('how far') || text.includes('near')) {
      return "Mittal Palms is located in Jakkur, North Bangalore, very close to Manyata Tech Park, Hebbal, and easy airport connectivity.";
    }

    // Amenities / Clubhouse
    if (text.includes('amenit') || text.includes('clubhouse') || text.includes('pool') || text.includes('gym') || text.includes('garden') || text.includes('facilities')) {
      return "Mittal Palms features a premium clubhouse, swimming pool, landscaped gardens, children's play area, 24/7 security, and full power backup across 3.2 acres.";
    }

    // General Project Overview
    if (text.includes('about mittal') || text.includes('tell me about') || text.includes('project details') || text.includes('overview') || text.includes('what is mittal palms')) {
      return "Mittal Palms is a premium 3.2-acre ready-to-move community in Jakkur, offering spacious 2 and 3 BHK residences with OC received. Are you looking for a 2 or 3 BHK?";
    }

    // 3. Entity Extraction & Progression
    this.extractEntities(text);

    // Severe budget mismatch
    if (this.state.budget && this.detectSevereBudgetMismatch(this.state.budget)) {
      this.state.leadQuality = 'Bad Lead';
      this.state.isQualified = true;
      this.state.qualificationReason = `Budget (${this.state.budget}) is below starting ₹1.25 Cr pricing for Mittal Palms.`;
      await this.syncLeadRecord();
      return "Understood! Our ready residences at Mittal Palms start from 1.25 Crore onwards. If your budget expands, we would love to assist you!";
    }

    // Walkthrough / Site Visit Scheduling
    const isVisitAgreed =
      text.includes('saturday') ||
      text.includes('sunday') ||
      text.includes('tomorrow') ||
      text.includes('weekend') ||
      text.includes('visit') ||
      text.includes('walkthrough') ||
      text.includes('morning') ||
      text.includes('evening') ||
      text.includes('afternoon') ||
      text.includes('11 am') ||
      text.includes('4 pm') ||
      text.includes('5 pm') ||
      text.includes('come over') ||
      text.includes('see the flat') ||
      text.includes('schedule');

    if (isVisitAgreed || (this.state.config && (text.includes('yes') || text.includes('sure') || text.includes('okay') || text.includes('fine')))) {
      this.state.siteVisit = 'Site Walkthrough Scheduled with Raghavendra';
      this.state.leadQuality = 'Good Lead';
      this.state.isQualified = true;
      this.state.qualificationReason = `Qualified buyer (${this.state.config || '2/3 BHK'}) for Mittal Palms, Jakkur. Walkthrough scheduled with Raghavendra (9945577935).`;
      await this.syncLeadRecord();
      return "Wonderful! That time is noted. Our relationship manager Raghavendra (9945577935) will be ready for you at Mittal Palms. I am also sending the location pin and floor plans on WhatsApp. Have a great day!";
    }

    // If configuration is identified, prompt for walkthrough or floor plans
    if (this.state.config) {
      return `Excellent, our ready ${this.state.config} residences at Mittal Palms have spacious layouts. Would you like to visit this Saturday for a personalized walkthrough with Raghavendra?`;
    }

    // Default guidance: ask 2 BHK vs 3 BHK
    return "At Mittal Palms in Jakkur, we have ready 2 and 3 BHK homes. Are you looking for a 2 BHK or a 3 BHK for your family?";
  }

  private extractEntities(text: string): void {
    if (!this.state.config) {
      if (/\b(2\s*bhk|2bhk|two\s*bhk|two\s*bedroom|2\s*bedroom)\b/i.test(text)) {
        this.state.config = '2 BHK';
      } else if (/\b(3\s*bhk|3bhk|three\s*bhk|three\s*bedroom|3\s*bedroom)\b/i.test(text)) {
        this.state.config = '3 BHK';
      }
    }

    if (!this.state.intent) {
      if (text.includes('self') || text.includes('family') || text.includes('live') || text.includes('own use')) {
        this.state.intent = 'Self-use';
      } else if (text.includes('invest') || text.includes('rental') || text.includes('roi')) {
        this.state.intent = 'Investment';
      }
    }

    if (!this.state.budget) {
      const budgetMatch = text.match(/(?:around|budget|under|upto|approx)?\s*([0-9.]+\s*(?:crore|cr|lakh|lakhs))/i);
      if (budgetMatch) {
        this.state.budget = budgetMatch[1];
      }
    }
  }

  private detectSevereBudgetMismatch(budget: string): boolean {
    const lakhMatch = budget.match(/([0-9.]+)\s*lakh/i);
    if (lakhMatch) {
      const val = parseFloat(lakhMatch[1]);
      if (val < 100) return true;
    }
    const crMatch = budget.match(/([0-9.]+)\s*cr/i);
    if (crMatch) {
      const val = parseFloat(crMatch[1]);
      if (val < 1.0) return true;
    }
    return false;
  }

  public async syncLeadRecord(): Promise<void> {
    try {
      await sheetsService.qualifyAndSyncLead({
        call_id: this.state.callId,
        caller_name: this.state.callerName,
        phone_number: this.state.callerPhone,
        configuration: this.state.config || '2/3 BHK',
        location_preference: 'Mittal Palms, Jakkur, North Bangalore',
        budget_bracket: this.state.budget || '1.25 - 1.95 Cr',
        intent: this.state.intent || 'Self-use',
        possession_timeline: 'Ready to move',
        site_visit_day: this.state.siteVisit || 'Pending',
        lead_quality: this.state.leadQuality || 'Good Lead',
        lead_status: this.state.siteVisit ? 'Good Lead - Hot (Visit Booked)' : 'Good Lead - Warm (Qualified)',
        qualification_reason: this.state.qualificationReason || 'Mittal Palms Jakkur inquiry',
      });
    } catch (err: any) {
      console.warn('[Qualifier] Lead sync notice:', err.message);
    }
  }
}
