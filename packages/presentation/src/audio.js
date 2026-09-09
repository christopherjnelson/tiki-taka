// The per-effect constants below are the mix balance and the ceiling: they are
// set so the loudest effect just fills the headroom, and they are deliberately
// not re-tuned per player. The master gain is the trim. At 1.0 effects peak
// between -8 and -16 dBFS, which is too loud beside the soundtrack; the default
// below is -10.5 dB, which lands a typical effect at about -22 dBFS peak and
// the loudest (turnover) at about -18.7 dBFS. Anything the player prefers is a
// slider move away, and the balance between effects is untouched by it.
export const DEFAULT_EFFECTS_VOLUME = 0.3;

export class Sound {
  constructor(enabled = true, volume = DEFAULT_EFFECTS_VOLUME) {
    this._enabled = Boolean(enabled);
    this._volume = clampVolume(volume, DEFAULT_EFFECTS_VOLUME);
    this.context = null;
    this.master = null;
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

  get volume() {
    return this._volume;
  }

  // A gain node rather than a rewrite of the constants, so the slider is a
  // master trim and the mix balance survives it.
  setVolume(value) {
    this._volume = clampVolume(value, this._volume);
    if (this.master) this.master.gain.value = this._volume;
    return this._volume;
  }

  // Callers (and the offline measurement harness) may swap `context` in after
  // construction, so the master gain is built lazily and rebuilt whenever the
  // context it belongs to changes.
  destination() {
    const ctx = this.context;
    if (!ctx) return null;
    if (!this.master || this.master.context !== ctx) {
      this.master = ctx.createGain();
      this.master.connect(ctx.destination);
    }
    this.master.gain.value = this._volume;
    return this.master;
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
    gain.connect(this.destination());
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
        emphatic ? 0.32 : 0.24,
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
    voiceGain.connect(this.destination());
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
        type === "turnover" ? 0.4 : type === "focus" ? 0.15 : 0.25,
        type === "kick" ? "triangle" : "sine",
      );
  }
}

function clampVolume(value, fallback) {
  const volume = Number(value);
  if (!Number.isFinite(volume)) return fallback;
  return Math.min(1, Math.max(0, volume));
}
