export class Sound {
  constructor(enabled = true) {
    this._enabled = Boolean(enabled);
    this.context = null;
    this.scheduled = new Set();
    this.lastCrowd = -Infinity;
  }

  get enabled() {
    return this._enabled;
  }

  set enabled(value) {
    this._enabled = Boolean(value);
    if (!this._enabled) this.stopScheduled();
  }

  unlock() {
    if (!this.enabled) return;
    try {
      this.context ||= new (window.AudioContext || window.webkitAudioContext)();
      if (this.context.state === "suspended")
        void this.context.resume().catch(() => {});
    } catch {}
  }

  stopScheduled() {
    for (const source of this.scheduled) {
      try {
        source.stop();
        source.disconnect();
      } catch {}
    }
    this.scheduled.clear();
  }

  track(source) {
    this.scheduled.add(source);
    source.addEventListener?.("ended", () => {
      this.scheduled.delete(source);
      try {
        source.disconnect();
      } catch {}
    });
  }

  tone(frequency, start, duration, volume, type = "sine") {
    const ctx = this.context,
      oscillator = ctx.createOscillator(),
      gain = ctx.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.linearRampToValueAtTime(volume, start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.001, start + duration);
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    this.track(oscillator);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.02);
  }

  crowdOle(event = {}) {
    const ctx = this.context,
      now = ctx.currentTime;
    if (now - this.lastCrowd < 0.42) return;
    this.lastCrowd = now;
    const emphatic = Boolean(event.milestone),
      voices = emphatic ? 5 : 3;
    for (let voice = 0; voice < voices; voice++) {
      const spread = voice - (voices - 1) / 2;
      this.crowdVoice(
        now + 0.025 + voice * 0.013,
        1 + spread * 0.021,
        emphatic ? 0.055 : 0.042,
      );
    }
  }

  crowdVoice(start, detune, volume) {
    const ctx = this.context,
      source = ctx.createOscillator(),
      vowelO = ctx.createBiquadFilter(),
      vowelE = ctx.createBiquadFilter(),
      voiceGain = ctx.createGain();
    source.type = "sawtooth";
    source.frequency.setValueAtTime(168 * detune, start);
    source.frequency.exponentialRampToValueAtTime(218 * detune, start + 0.34);
    source.frequency.setValueAtTime(218 * detune, start + 0.36);
    vowelO.type = "bandpass";
    vowelO.Q.value = 7;
    vowelO.frequency.setValueAtTime(500 * detune, start);
    vowelO.frequency.exponentialRampToValueAtTime(405 * detune, start + 0.34);
    vowelE.type = "bandpass";
    vowelE.Q.value = 9;
    vowelE.frequency.setValueAtTime(850 * detune, start);
    vowelE.frequency.exponentialRampToValueAtTime(1780 * detune, start + 0.4);
    voiceGain.gain.setValueAtTime(0.0001, start);
    voiceGain.gain.linearRampToValueAtTime(volume, start + 0.035);
    voiceGain.gain.exponentialRampToValueAtTime(volume * 0.38, start + 0.27);
    voiceGain.gain.linearRampToValueAtTime(volume * 0.82, start + 0.36);
    voiceGain.gain.exponentialRampToValueAtTime(0.001, start + 0.82);
    source.connect(vowelO);
    source.connect(vowelE);
    vowelO.connect(voiceGain);
    vowelE.connect(voiceGain);
    voiceGain.connect(ctx.destination);
    this.track(source);
    source.start(start);
    source.stop(start + 0.84);
  }

  play(type, event = {}) {
    if (!this.enabled || !this.context) return;
    if (type === "one-touch" && (event.milestone || event.streak >= 10)) {
      this.crowdOle(event);
      return;
    }
    const ctx = this.context,
      start = ctx.currentTime,
      notes =
        type === "score"
          ? [440, 660]
          : type === "focus"
            ? [520]
            : type === "turnover"
              ? [150, 100]
              : type === "end"
                ? [330, 440, 660]
                : type === "wall"
                  ? [300]
                  : type === "one-touch"
                    ? [560, 720]
                    : [180];
    for (let i = 0; i < notes.length; i++)
      this.tone(
        notes[i],
        start + i * 0.07,
        0.14,
        type === "turnover" ? 0.09 : type === "focus" ? 0.025 : 0.045,
        type === "kick" ? "triangle" : "sine",
      );
  }
}
