/**
 * Script Engine for Nisha Prasad - Real Estate Investment Qualification Call
 *
 * Implements the exact conversation script specified:
 * 1. Greeting: "Hi, am I speaking with Eric Dsouza? Good Morning/Afternoon/Evening, Eric."
 * 2. Interest Check: "I am Nisha Prasad, just wanted to know are you currently looking for any investment options in Real Estate?"
 * 3. Question 1: "Are you looking for an apartment, plot or villas?"
 * 4. Question 2: "How many bedrooms are you looking for?"
 * 5. Question 3: "Any particular size in mind?"
 * 6. Question 4: "Is it for self use or investment?"
 * 7. Question 5: "May I know your budget?"
 * 8. Question 6: "Which location do you prefer?"
 * 9. Question 7: "Are you looking for ready to move in or under construction?"
 * 10. Question 8: "How soon are you looking to book?"
 * 11. Wrap-up Q: "Thank you so much for the information. May I know what is the best time for us to reach you at?"
 * 12. Conclusion: "Thank you so much, Eric! We will reach out to you then. Have a wonderful day! Goodbye."
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
  WRAP_UP = 11,
  COMPLETED = 12,
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
   * Returns the next script line based on the current step and user input.
   */
  public getNextScriptLine(userText: string): { response: string; step: ScriptStep; shouldClose?: boolean } {
    const text = (userText || '').toLowerCase().trim();

    // Opt-out detection
    const isOptOut = /\b(not interested|don't call|dont call|never call|stop calling|wrong number|remove my number|no need|not looking|nahi chahiye|nahin chahiye)\b/i.test(text);
    if (isOptOut) {
      this.currentStep = ScriptStep.COMPLETED;
      return {
        response: 'I completely understand. Thank you for your time Eric, have a wonderful day ahead. Goodbye!',
        step: ScriptStep.COMPLETED,
        shouldClose: true,
      };
    }

    // Step 0 -> Step 1 (Greeting answered with confirmation: "Yes", "Speaking", "Yeah")
    if (this.currentStep === ScriptStep.GREETING) {
      this.currentStep = ScriptStep.CONFIRM_INTEREST;
      return {
        response: 'I am Nisha Prasad, just wanted to know are you currently looking for any investment options in Real Estate?',
        step: ScriptStep.CONFIRM_INTEREST,
      };
    }

    // Step 1 -> Step 2 (Interest confirmed: "Yes", "I am looking", "Looking for property")
    if (this.currentStep === ScriptStep.CONFIRM_INTEREST) {
      const isNegative = /\b(no|not|nah|nope|not looking)\b/i.test(text);
      if (isNegative) {
        this.currentStep = ScriptStep.COMPLETED;
        return {
          response: 'I completely understand. Thank you for your time Eric, have a wonderful day ahead. Goodbye!',
          step: ScriptStep.COMPLETED,
          shouldClose: true,
        };
      }
      this.data.isLooking = true;
      this.currentStep = ScriptStep.Q1_PROPERTY_TYPE;
      return {
        response: 'Are you looking for an apartment, plot or villas?',
        step: ScriptStep.Q1_PROPERTY_TYPE,
      };
    }

    // Step 2 -> Step 3 (Q1 answered -> Q2 Bedrooms)
    if (this.currentStep === ScriptStep.Q1_PROPERTY_TYPE) {
      this.data.propertyType = userText;
      // Check if user also gave bedrooms
      if (/\b(\d+\s*bhk|\d+\s*bed)\b/i.test(text)) {
        this.data.bedrooms = userText;
        this.currentStep = ScriptStep.Q3_SIZE;
        return {
          response: 'Got it! Any particular size in mind?',
          step: ScriptStep.Q3_SIZE,
        };
      }
      this.currentStep = ScriptStep.Q2_BEDROOMS;
      return {
        response: 'How many bedrooms are you looking for?',
        step: ScriptStep.Q2_BEDROOMS,
      };
    }

    // Step 3 -> Step 4 (Q2 answered -> Q3 Size)
    if (this.currentStep === ScriptStep.Q2_BEDROOMS) {
      this.data.bedrooms = userText;
      this.currentStep = ScriptStep.Q3_SIZE;
      return {
        response: 'Any particular size in mind?',
        step: ScriptStep.Q3_SIZE,
      };
    }

    // Step 4 -> Step 5 (Q3 answered -> Q4 Purpose: Self-use or investment)
    if (this.currentStep === ScriptStep.Q3_SIZE) {
      this.data.sizeInMind = userText;
      this.currentStep = ScriptStep.Q4_PURPOSE;
      return {
        response: 'Is it for self use or investment?',
        step: ScriptStep.Q4_PURPOSE,
      };
    }

    // Step 5 -> Step 6 (Q4 answered -> Q5 Budget)
    if (this.currentStep === ScriptStep.Q4_PURPOSE) {
      this.data.purpose = userText;
      this.currentStep = ScriptStep.Q5_BUDGET;
      return {
        response: 'May I know your budget?',
        step: ScriptStep.Q5_BUDGET,
      };
    }

    // Step 6 -> Step 7 (Q5 answered -> Q6 Location)
    if (this.currentStep === ScriptStep.Q5_BUDGET) {
      this.data.budget = userText;
      this.currentStep = ScriptStep.Q6_LOCATION;
      return {
        response: 'Which location do you prefer?',
        step: ScriptStep.Q6_LOCATION,
      };
    }

    // Step 7 -> Step 8 (Q6 answered -> Q7 Ready to move in or under construction)
    if (this.currentStep === ScriptStep.Q6_LOCATION) {
      this.data.preferredLocation = userText;
      this.currentStep = ScriptStep.Q7_CONSTRUCTION_STATUS;
      return {
        response: 'Are you looking for ready to move in or under construction?',
        step: ScriptStep.Q7_CONSTRUCTION_STATUS,
      };
    }

    // Step 8 -> Step 9 (Q7 answered -> Q8 Booking timeline)
    if (this.currentStep === ScriptStep.Q7_CONSTRUCTION_STATUS) {
      this.data.constructionStatus = userText;
      this.currentStep = ScriptStep.Q8_BOOKING_TIMELINE;
      return {
        response: 'How soon are you looking to book?',
        step: ScriptStep.Q8_BOOKING_TIMELINE,
      };
    }

    // Step 9 -> Step 10 (Q8 answered -> Best time to reach)
    if (this.currentStep === ScriptStep.Q8_BOOKING_TIMELINE) {
      this.data.bookingTimeline = userText;
      this.currentStep = ScriptStep.BEST_TIME_TO_REACH;
      return {
        response: 'Thank you so much for the information. May I know what is the best time for us to reach you at?',
        step: ScriptStep.BEST_TIME_TO_REACH,
      };
    }

    // Step 10 -> Step 11 (Best time answered -> Conclusion)
    if (this.currentStep === ScriptStep.BEST_TIME_TO_REACH) {
      this.data.bestTimeToReach = userText;
      this.currentStep = ScriptStep.COMPLETED;
      return {
        response: 'Thank you so much, Eric! We will reach out to you then. Have a wonderful day! Goodbye.',
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
