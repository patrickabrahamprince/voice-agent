/**
 * SarvamCircuitBreaker
 * Automatically trips when Sarvam AI returns HTTP 402 / Credits exhausted.
 * Prevents 5-10 second cascade timeouts on every turn by instantly routing
 * STT to Groq Whisper and LLM to Groq Qwen with 0ms wasted delay.
 */
class SarvamCircuitBreaker {
  private _isExhausted: boolean = true; // Initialized to true since Sarvam 402 was verified
  private _lastChecked: number = Date.now();
  private readonly PROBE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

  get isExhausted(): boolean {
    if (this._isExhausted && Date.now() - this._lastChecked > this.PROBE_INTERVAL_MS) {
      // Allow 1 probe request after 5 minutes to test if user recharged credits
      return false;
    }
    return this._isExhausted;
  }

  markExhausted(): void {
    if (!this._isExhausted) {
      console.warn('⚠️ [SarvamCircuitBreaker] Sarvam credits exhausted. Tripping circuit breaker: bypassing Sarvam for instant 0ms fallback to Groq.');
    }
    this._isExhausted = true;
    this._lastChecked = Date.now();
  }

  reset(): void {
    console.log('🔄 [SarvamCircuitBreaker] Circuit breaker reset. Sarvam AI re-enabled.');
    this._isExhausted = false;
    this._lastChecked = Date.now();
  }

  getStatus(): { isExhausted: boolean; timeSinceCheckMs: number } {
    return {
      isExhausted: this._isExhausted,
      timeSinceCheckMs: Date.now() - this._lastChecked,
    };
  }
}

export const sarvamCircuitBreaker = new SarvamCircuitBreaker();
