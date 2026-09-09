// The per-effect constants below are the mix balance and the ceiling: they are
// set so the loudest effect just fills the headroom, and they are deliberately
// not re-tuned per player. The master gain is the trim. At 1.0 effects peak
// between -8 and -16 dBFS, which is too loud beside the soundtrack; the default
// below is -10.5 dB, which lands a typical effect at about -22 dBFS peak and
// the loudest (turnover) at about -18.7 dBFS. Anything the player prefers is a
// slider move away, and the balance between effects is untouched by it.
export const DEFAULT_EFFECTS_VOLUME = 0.3;
// The kick's two halves, in the same units as the tone volumes below: the body
// carries the level and the noise transient is deliberately far under it.
const KICK_BODY = 0.26,
  KICK_TRANSIENT = 0.05;

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

  // A shared quarter-second of white noise, made once per context. The kick's
  // transient is a slice of it: allocating a buffer per pass would churn on a
  // fast one-touch chain.
  noiseBuffer() {
    const ctx = this.context;
    if (this.noise?.context !== ctx) {
      const buffer = ctx.createBuffer(
          1,
          Math.ceil(ctx.sampleRate * 0.25),
          ctx.sampleRate,
        ),
        samples = buffer.getChannelData(0);
      for (let i = 0; i < samples.length; i++)
        samples[i] = Math.random() * 2 - 1;
      this.noise = { context: ctx, buffer };
    }
    return this.noise.buffer;
  }

  // The pass used to be a 180Hz triangle held for 140ms: a beep. A struck ball
  // is two things at once — a body whose pitch falls away as the ball leaves
  // the boot, and a very short scrape of noise where foot meets leather. The
  // body carries the level; the transient is mixed far under it so the result
  // reads as a soft thud rather than a click or a dance-floor kick drum. The
  // constants are the mix, like every other effect here: the master gain is
  // the only trim. Measured through the master at its 0.3 default this peaks
  // at about -22 dBFS, the same place the other effects sit, and at trim 1.0
  // it stays clear of full scale.
  kick(start) {
    const ctx = this.context,
      out = this.destination(),
      body = ctx.createOscillator(),
      bodyGain = ctx.createGain();
    body.type = "sine";
    body.frequency.setValueAtTime(170, start);
    body.frequency.exponentialRampToValueAtTime(55, start + 0.06);
    bodyGain.gain.setValueAtTime(0.0001, start);
    bodyGain.gain.linearRampToValueAtTime(KICK_BODY, start + 0.002);
    bodyGain.gain.exponentialRampToValueAtTime(0.0006, start + 0.12);
    body.connect(bodyGain);
    bodyGain.connect(out);
    this.track(body);
    body.start(start);
    body.stop(start + 0.15);
    const noise = ctx.createBufferSource(),
      band = ctx.createBiquadFilter(),
      noiseGain = ctx.createGain();
    noise.buffer = this.noiseBuffer();
    band.type = "bandpass";
    band.frequency.setValueAtTime(2100, start);
    band.frequency.exponentialRampToValueAtTime(1500, start + 0.02);
    band.Q.value = 0.9;
    noiseGain.gain.setValueAtTime(0.0001, start);
    noiseGain.gain.linearRampToValueAtTime(KICK_TRANSIENT, start + 0.002);
    noiseGain.gain.exponentialRampToValueAtTime(0.0004, start + 0.02);
    noise.connect(band);
    band.connect(noiseGain);
    noiseGain.connect(out);
    this.track(noise);
    noise.start(start);
    noise.stop(start + 0.05);
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
      start = ctx.currentTime;
    if (type === "kick") {
      this.kick(start);
      return;
    }
    const notes =
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
      );
  }
}

function clampVolume(value, fallback) {
  const volume = Number(value);
  if (!Number.isFinite(volume)) return fallback;
  return Math.min(1, Math.max(0, volume));
}
