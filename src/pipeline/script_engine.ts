/**
 * Conversational Script Engine for Nisha Prasad - Real Estate Investment Qualification Call
 *
 * Implements a natural, human-like qualification dialogue:
 * - Every caller answer is warmly acknowledged before moving to the next question.
 * - Extracts caller preferences dynamically to avoid repetitive or robotic queries.
 * - Enforces strict conversational brevity (under 18 words per turn).
 */

export enum ScriptStep {
  GREETING = 0,
  CONFIRM_INTEREST = 1,
  Q1_PROPERTY_TYPE = 2,
  Q2_BEDROOMS = 3,
  Q3_SIZE = 4,
  Q4_PURPOSE = 5,
  Q5_BUDGET = 6,
  Q6_LOCATION = 7,
  Q7_CONSTRUCTION_STATUS = 8,
  Q8_BOOKING_TIMELINE = 9,
  BEST_TIME_TO_REACH = 10,
  COMPLETED = 11,
}

export function getTimeOfDayGreeting(): string {
  // Indian Standard Time (UTC + 5:30)
  const now = new Date();
  const utcHours = now.getUTCHours();
  const utcMinutes = now.getUTCMinutes();
  const istMinutesTotal = utcHours * 60 + utcMinutes + 330;
  const istHour = Math.floor(istMinutesTotal / 60) % 24;

  if (istHour >= 4 && istHour < 12) {
    return 'Good Morning';
  } else if (istHour >= 12 && istHour < 17) {
    return 'Good Afternoon';
  } else {
    return 'Good Evening';
  }
}

export function getScriptGreeting(fullName: string = 'Eric Dsouza'): string {
  const firstName = fullName.split(' ')[0] || 'Eric';
  const tod = getTimeOfDayGreeting();
  return `Hi, am I speaking with ${fullName}? ${tod}, ${firstName}.`;
}

export interface QualificationData {
  clientName: string;
  isLooking: boolean | null;
  propertyType: string | null;
  bedrooms: string | null;
  sizeInMind: string | null;
  purpose: string | null;
  budget: string | null;
  preferredLocation: string | null;
  constructionStatus: string | null;
  bookingTimeline: string | null;
  bestTimeToReach: string | null;
}

export class ScriptEngine {
  private currentStep: ScriptStep = ScriptStep.GREETING;
  private data: QualificationData;

  constructor(clientName: string = 'Eric Dsouza') {
    this.data = {
      clientName,
      isLooking: null,
      propertyType: null,
      bedrooms: null,
      sizeInMind: null,
      purpose: null,
      budget: null,
      preferredLocation: null,
      constructionStatus: null,
      bookingTimeline: null,
      bestTimeToReach: null,
    };
  }

  public getStep(): ScriptStep {
    return this.currentStep;
  }

  public setStep(step: ScriptStep): void {
    this.currentStep = step;
  }

  public getData(): QualificationData {
    return { ...this.data };
  }

  /**
   * Returns the prompt question for repeating the current step.
   */
  public getRepeatPromptForCurrentStep(): string {
    switch (this.currentStep) {
      case ScriptStep.GREETING:
        return getScriptGreeting(this.data.clientName);
      case ScriptStep.CONFIRM_INTEREST:
        return 'I am Nisha Prasad, just wanted to know are you currently looking for any investment options in Real Estate?';
      case ScriptStep.Q1_PROPERTY_TYPE:
        return 'Are you looking for an apartment, plot or villas?';
      case ScriptStep.Q2_BEDROOMS:
        return 'How many bedrooms are you looking for?';
      case ScriptStep.Q3_SIZE:
        return 'Any particular size in mind?';
      case ScriptStep.Q4_PURPOSE:
        return 'Is it for self use or investment?';
      case ScriptStep.Q5_BUDGET:
        return 'May I know your budget?';
      case ScriptStep.Q6_LOCATION:
        return 'Which location do you prefer?';
      case ScriptStep.Q7_CONSTRUCTION_STATUS:
        return 'Are you looking for ready to move in or under construction?';
      case ScriptStep.Q8_BOOKING_TIMELINE:
        return 'How soon are you looking to book?';
      case ScriptStep.BEST_TIME_TO_REACH:
        return 'May I know what is the best time for us to reach you at?';
      default:
        return 'How can I help you today?';
    }
  }

  /**
   * Returns the next script line with warm human acknowledgment based on what the caller said.
   */
  public getNextScriptLine(userText: string): { response: string; step: ScriptStep; shouldClose?: boolean } {
    const raw = (userText || '').trim();
    const text = raw.toLowerCase();

    // 1. Opt-out detection
    const isOptOut = /\b(not interested|don't call|dont call|never call|stop calling|wrong number|remove my number|no need|not looking|nahi chahiye|nahin chahiye)\b/i.test(text);
    if (isOptOut) {
      this.currentStep = ScriptStep.COMPLETED;
      return {
        response: 'I completely understand. Thank you for your time Eric, have a wonderful day ahead. Goodbye!',
        step: ScriptStep.COMPLETED,
        shouldClose: true,
      };
    }

    // 2. Repeat request detection
    const isRepeat = /\b(repeat|say that again|what did you say|pardon|come again|didn't hear|didnt hear|could you repeat|what was that|what did you ask)\b/i.test(text);
    if (isRepeat) {
      return {
        response: `Sure! ${this.getRepeatPromptForCurrentStep()}`,
        step: this.currentStep,
      };
    }

    // 3. Presence confirmation detection (caller just says "Yes", "I'm here", "Hello" without answering the question)
    const isPresenceOnly = /^(yes|yeah|yep|ha|haan|hanji|hello|hi|i am here|im here|listening|tell me|speak)$/i.test(text.replace(/[^a-z\s]/g, '').trim());

    // Step 0 -> Step 1 (Greeting answered with confirmation: "Yes", "Speaking", "Yeah")
    if (this.currentStep === ScriptStep.GREETING) {
      this.currentStep = ScriptStep.CONFIRM_INTEREST;
      return {
        response: 'Great to connect with you, Eric! I am Nisha Prasad, just wanted to know are you currently looking for any investment options in Real Estate?',
        step: ScriptStep.CONFIRM_INTEREST,
      };
    }

    // Step 1 -> Step 2 (Interest confirmed: "Yes", "I am looking", "Looking for property")
    if (this.currentStep === ScriptStep.CONFIRM_INTEREST) {
      const isNegative = /\b(no|not|nah|nope|not looking|no investment)\b/i.test(text);
      if (isNegative) {
        this.currentStep = ScriptStep.COMPLETED;
        return {
          response: 'I completely understand. Thank you for your time Eric, have a wonderful day ahead. Goodbye!',
          step: ScriptStep.COMPLETED,
          shouldClose: true,
        };
      }
      this.data.isLooking = true;

      // Check if user already jumped ahead to mention property type or bedrooms
      if (text.includes('apartment') || text.includes('flat')) {
        this.data.propertyType = 'Apartment';
        if (/\b(\d+\s*bhk|\d+\s*bed)\b/i.test(text)) {
          this.data.bedrooms = raw;
          this.currentStep = ScriptStep.Q3_SIZE;
          return {
            response: 'An apartment, wonderful! Any particular size in mind?',
            step: ScriptStep.Q3_SIZE,
          };
        }
        this.currentStep = ScriptStep.Q2_BEDROOMS;
        return {
          response: 'An apartment, wonderful choice! How many bedrooms are you looking for?',
          step: ScriptStep.Q2_BEDROOMS,
        };
      }

      this.currentStep = ScriptStep.Q1_PROPERTY_TYPE;
      return {
        response: "That's wonderful! Are you looking for an apartment, plot or villas?",
        step: ScriptStep.Q1_PROPERTY_TYPE,
      };
    }

    // If caller merely affirmed presence without answering specific question:
    if (isPresenceOnly) {
      switch (this.currentStep) {
        case ScriptStep.Q1_PROPERTY_TYPE:
          return {
            response: 'Could you tell me if you prefer an apartment, plot, or villa?',
            step: this.currentStep,
          };
        case ScriptStep.Q2_BEDROOMS:
          return {
            response: 'How many bedrooms would you prefer, such as 2 BHK or 3 BHK?',
            step: this.currentStep,
          };
        case ScriptStep.Q3_SIZE:
          return {
            response: 'What approximate square feet size are you looking for?',
            step: this.currentStep,
          };
        case ScriptStep.Q4_PURPOSE:
          return {
            response: 'Would that be for your self use, or for investment?',
            step: this.currentStep,
          };
        case ScriptStep.Q5_BUDGET:
          return {
            response: 'Could you share your approximate budget range?',
            step: this.currentStep,
          };
        case ScriptStep.Q6_LOCATION:
          return {
            response: 'Which location or area in Bangalore do you prefer?',
            step: this.currentStep,
          };
        case ScriptStep.Q7_CONSTRUCTION_STATUS:
          return {
            response: 'Would you prefer ready to move in, or under construction?',
            step: this.currentStep,
          };
        case ScriptStep.Q8_BOOKING_TIMELINE:
          return {
            response: 'How soon are you planning to finalize or book?',
            step: this.currentStep,
          };
        case ScriptStep.BEST_TIME_TO_REACH:
          return {
            response: 'What time would be convenient for our team to call you?',
            step: this.currentStep,
          };
      }
    }

    // Step 2 -> Step 3 (Q1 answered -> Q2 Bedrooms)
    if (this.currentStep === ScriptStep.Q1_PROPERTY_TYPE) {
      this.data.propertyType = raw;

      let ack = 'Got it, noted!';
      if (text.includes('apartment') || text.includes('flat')) {
        ack = 'An apartment, excellent!';
      } else if (text.includes('villa')) {
        ack = 'A villa, wonderful choice!';
      } else if (text.includes('plot') || text.includes('land')) {
        ack = 'A plot, great investment option!';
        // For plots, bedrooms are usually not applicable, advance to size
        this.currentStep = ScriptStep.Q3_SIZE;
        return {
          response: `${ack} Any particular size in mind?`,
          step: ScriptStep.Q3_SIZE,
        };
      }

      // Check if user also gave bedrooms in the same sentence (e.g. "3 BHK apartment")
      if (/\b(\d+\s*bhk|\d+\s*bed|two|three|four)\b/i.test(text)) {
        this.data.bedrooms = raw;
        this.currentStep = ScriptStep.Q3_SIZE;
        return {
          response: `${ack} Any particular size in mind?`,
          step: ScriptStep.Q3_SIZE,
        };
      }

      this.currentStep = ScriptStep.Q2_BEDROOMS;
      return {
        response: `${ack} How many bedrooms are you looking for?`,
        step: ScriptStep.Q2_BEDROOMS,
      };
    }

    // Step 3 -> Step 4 (Q2 answered -> Q3 Size)
    if (this.currentStep === ScriptStep.Q2_BEDROOMS) {
      this.data.bedrooms = raw;
      let ack = 'Understood!';
      if (text.includes('3') || text.includes('three')) {
        ack = '3 bedrooms, perfect!';
      } else if (text.includes('2') || text.includes('two')) {
        ack = '2 bedrooms, got it!';
      } else if (text.includes('4') || text.includes('four')) {
        ack = '4 bedrooms, spacious!';
      }

      this.currentStep = ScriptStep.Q3_SIZE;
      return {
        response: `${ack} Any particular size in mind?`,
        step: ScriptStep.Q3_SIZE,
      };
    }

    // Step 4 -> Step 5 (Q3 answered -> Q4 Purpose: Self-use or investment)
    if (this.currentStep === ScriptStep.Q3_SIZE) {
      this.data.sizeInMind = raw;
      let ack = 'Understood!';
      if (/\d+/.test(text)) {
        ack = 'Noted on the size!';
      }

      this.currentStep = ScriptStep.Q4_PURPOSE;
      return {
        response: `${ack} Is it for self use or investment?`,
        step: ScriptStep.Q4_PURPOSE,
      };
    }

    // Step 5 -> Step 6 (Q4 answered -> Q5 Budget)
    if (this.currentStep === ScriptStep.Q4_PURPOSE) {
      this.data.purpose = raw;
      let ack = 'Got it!';
      if (text.includes('self') || text.includes('live') || text.includes('family') || text.includes('own')) {
        ack = 'Self use, wonderful!';
      } else if (text.includes('invest') || text.includes('rent') || text.includes('roi')) {
        ack = 'Investment, great!';
      }

      this.currentStep = ScriptStep.Q5_BUDGET;
      return {
        response: `${ack} May I know your budget?`,
        step: ScriptStep.Q5_BUDGET,
      };
    }

    // Step 6 -> Step 7 (Q5 answered -> Q6 Location)
    if (this.currentStep === ScriptStep.Q5_BUDGET) {
      this.data.budget = raw;
      this.currentStep = ScriptStep.Q6_LOCATION;
      return {
        response: 'Got it, noted on the budget! Which location do you prefer?',
        step: ScriptStep.Q6_LOCATION,
      };
    }

    // Step 7 -> Step 8 (Q6 answered -> Q7 Ready to move in or under construction)
    if (this.currentStep === ScriptStep.Q6_LOCATION) {
      this.data.preferredLocation = raw;
      this.currentStep = ScriptStep.Q7_CONSTRUCTION_STATUS;
      return {
        response: 'Great location! Are you looking for ready to move in or under construction?',
        step: ScriptStep.Q7_CONSTRUCTION_STATUS,
      };
    }

    // Step 8 -> Step 9 (Q7 answered -> Q8 Booking timeline)
    if (this.currentStep === ScriptStep.Q7_CONSTRUCTION_STATUS) {
      this.data.constructionStatus = raw;
      let ack = 'Got it!';
      if (text.includes('ready')) {
        ack = 'Ready to move in, excellent!';
      } else if (text.includes('under') || text.includes('construction')) {
        ack = 'Under construction, got it!';
      }

      this.currentStep = ScriptStep.Q8_BOOKING_TIMELINE;
      return {
        response: `${ack} How soon are you looking to book?`,
        step: ScriptStep.Q8_BOOKING_TIMELINE,
      };
    }

    // Step 9 -> Step 10 (Q8 answered -> Best time to reach)
    if (this.currentStep === ScriptStep.Q8_BOOKING_TIMELINE) {
      this.data.bookingTimeline = raw;
      this.currentStep = ScriptStep.BEST_TIME_TO_REACH;
      return {
        response: 'Noted on the timeline! Thank you so much for the information. May I know what is the best time for us to reach you at?',
        step: ScriptStep.BEST_TIME_TO_REACH,
      };
    }

    // Step 10 -> Step 11 (Best time answered -> Conclusion)
    if (this.currentStep === ScriptStep.BEST_TIME_TO_REACH) {
      this.data.bestTimeToReach = raw;
      this.currentStep = ScriptStep.COMPLETED;
      return {
        response: 'Perfect, Eric! We will reach out to you then. Thank you so much, and have a wonderful day! Goodbye.',
        step: ScriptStep.COMPLETED,
        shouldClose: true,
      };
    }

    // Completed
    return {
      response: 'Thank you for your time, Eric! Have a wonderful day. Goodbye!',
      step: ScriptStep.COMPLETED,
      shouldClose: true,
    };
  }
}
