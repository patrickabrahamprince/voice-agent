import { EventEmitter } from 'events';

export type CallEventType =
  | 'call_started'
  | 'agent_speaking'
  | 'caller_speech'
  | 'barge_in'
  | 'lead_update'
  | 'call_ended';

export interface LiveCallEvent {
  type: CallEventType;
  streamSid: string;
  callerNumber: string;
  timestamp: string;
  data: any;
}

export interface ActiveCallState {
  streamSid: string;
  callerNumber: string;
  agentName: string;
  startTime: number;
  status: 'active' | 'ended';
  isAgentSpeaking: boolean;
  transcript: Array<{ role: 'agent' | 'caller'; text: string; time: string }>;
  leadInfo: {
    config?: string | null;
    budget?: string | null;
    intent?: string | null;
    location?: string | null;
    isQualified?: boolean;
  };
  summary?: string;
}

class CallEventsBroadcaster extends EventEmitter {
  private activeClients = new Set<(event: LiveCallEvent) => void>();
  private activeCalls = new Map<string, ActiveCallState>();

  /**
   * Subscribes a SSE / WebSocket client to the live call event stream.
   */
  public subscribe(client: (event: LiveCallEvent) => void): () => void {
    this.activeClients.add(client);
    return () => {
      this.activeClients.delete(client);
    };
  }

  /**
   * Broadcasts a live call event to all connected dashboard clients and updates in-memory state.
   */
  public broadcast(event: LiveCallEvent): void {
    const { type, streamSid, callerNumber, data } = event;

    // Track active call state
    if (type === 'call_started') {
      this.activeCalls.set(streamSid, {
        streamSid,
        callerNumber,
        agentName: data?.agentName || 'Priya',
        startTime: Date.now(),
        status: 'active',
        isAgentSpeaking: false,
        transcript: data?.greeting
          ? [{ role: 'agent', text: data.greeting, time: new Date().toLocaleTimeString('en-IN') }]
          : [],
        leadInfo: {},
      });
    } else {
      const call = this.activeCalls.get(streamSid);
      if (call) {
        if (type === 'agent_speaking' && data?.text) {
          call.isAgentSpeaking = true;
          call.transcript.push({
            role: 'agent',
            text: data.text,
            time: new Date().toLocaleTimeString('en-IN'),
          });
        } else if (type === 'caller_speech' && data?.transcript) {
          call.isAgentSpeaking = false;
          call.transcript.push({
            role: 'caller',
            text: data.transcript,
            time: new Date().toLocaleTimeString('en-IN'),
          });
        } else if (type === 'barge_in') {
          call.isAgentSpeaking = false;
        } else if (type === 'lead_update' && data) {
          call.leadInfo = { ...call.leadInfo, ...data };
        } else if (type === 'call_ended') {
          call.status = 'ended';
          call.summary = data?.summary;
          // Keep completed call in memory for 10 minutes then prune
          setTimeout(() => {
            this.activeCalls.delete(streamSid);
          }, 600000);
        }
      }
    }

    // Emit event
    this.emit('call_event', event);

    // Send to all subscribers
    for (const client of this.activeClients) {
      try {
        client(event);
      } catch {
        this.activeClients.delete(client);
      }
    }
  }

  /**
   * Returns current active calls for clients connecting mid-call.
   */
  public getActiveCalls(): ActiveCallState[] {
    return Array.from(this.activeCalls.values());
  }

  /**
   * Returns the latest active call (if any) or most recent completed call.
   */
  public getLatestCall(): ActiveCallState | null {
    const all = Array.from(this.activeCalls.values());
    if (all.length === 0) return null;
    return all[all.length - 1];
  }
}

export const callEventsBroadcaster = new CallEventsBroadcaster();
