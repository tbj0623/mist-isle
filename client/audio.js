export class GameAudio {
  constructor() { this.enabled = true; this.context = null; this.lastShot = 0; }
  unlock() {
    if (!this.enabled) return;
    try {
      this.context ||= new (window.AudioContext || window.webkitAudioContext)();
      if (this.context.state === 'suspended') this.context.resume().catch(() => {});
    } catch { this.enabled = false; }
  }
  suspend() { this.context?.suspend().catch(() => {}); }
  play(type, weapon) {
    if (!this.enabled || !this.context || this.context.state !== 'running') return;
    const ctx = this.context, t = ctx.currentTime;
    if (type === 'shot') {
      if (t - this.lastShot < .075) return;
      this.lastShot = t;
    }
    const oscillator = ctx.createOscillator(), gain = ctx.createGain();
    oscillator.connect(gain); gain.connect(ctx.destination);
    const duration = type === 'shot' ? .09 : type === 'end' ? .8 : .19;
    oscillator.type = type === 'shot' ? 'sawtooth' : 'sine';
    const start = type === 'shot' ? (weapon === 'shotgun' ? 90 : 170) : type === 'pickup' ? 600 : type === 'heal' ? 380 : 520;
    oscillator.frequency.setValueAtTime(start, t);
    oscillator.frequency.exponentialRampToValueAtTime(type === 'shot' ? 42 : start * 1.5, t + duration);
    gain.gain.setValueAtTime(type === 'shot' ? .027 : .065, t);
    gain.gain.exponentialRampToValueAtTime(.001, t + duration);
    oscillator.start(t); oscillator.stop(t + duration + .01);
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
  }
}
