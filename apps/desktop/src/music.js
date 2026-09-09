// Looping soundtrack for the desktop shell.
//
// packages/presentation/src/audio.js is inside the mobile freeze and is
// procedural Web Audio only, so streamed music lives here instead. A decoded
// AudioBuffer with loop = true is used rather than <audio loop>, because the
// element loop re-opens the decoder at the wrap and leaves an audible gap;
// a looping buffer source is sample-accurate and therefore seamless.
//
// Everything is same-origin, so `default-src 'self'` (the shell's CSP, served
// over tiki://) covers both the fetch and the playback with no media-src of
// its own.

const FADE = 0.35;

// The track is a loud master: it peaks at -1.4 dBFS and averages -14.1 dBFS.
// Effects now peak between -8 and -16 dBFS, but they are 140 ms transients
// while music is continuous, so it is the music's *average* that decides
// whether they cut through. -17.7 dB of gain puts the soundtrack's mean at
// about -32 dBFS and its peaks at about -19 dBFS: under every effect, still
// clearly present underneath the game.
// `volume` is that tuned level and stays the ceiling; the player's music
// slider is a 0..1 trim on top of it, so the balance against the effects bus
// survives any setting.
export function createMusic({ sources = [], volume = 0.13, trim = 1 } = {}) {
  const base = volume;
  let level = base * clampTrim(trim, 1),
    context = null,
    gain = null,
    source = null,
    buffer = null,
    loading = null,
    enabled = false,
    unlocked = false,
    failed = false,
    offset = 0,
    startedAt = 0;

  function makeContext() {
    if (context) return context;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    try {
      context = new Ctor();
      gain = context.createGain();
      gain.gain.value = 0;
      gain.connect(context.destination);
    } catch {
      context = null;
      failed = true;
    }
    return context;
  }

  async function decode() {
    if (buffer || failed) return buffer;
    loading ||= (async () => {
      // The built shell keeps the track beside index.html; the source tree
      // serves it out of public/. Try each candidate rather than teaching the
      // dev server a new alias.
      let last;
      for (const candidate of sources) {
        try {
          const response = await fetch(candidate);
          if (!response.ok) throw new Error(`music ${response.status}`);
          const bytes = await response.arrayBuffer();
          return await context.decodeAudioData(bytes);
        } catch (error) {
          last = error;
        }
      }
      throw last || new Error("no music source");
    })()
      .then((decoded) => (buffer = decoded))
      .catch(() => {
        failed = true;
        return null;
      });
    return loading;
  }

  function stopSource({ keepPosition = true } = {}) {
    if (!source) return;
    // Remember where the track was so a mute/unmute does not restart it.
    if (keepPosition && context && buffer)
      offset = (context.currentTime - startedAt + offset) % buffer.duration;
    try {
      gain.gain.cancelScheduledValues(context.currentTime);
      gain.gain.setValueAtTime(gain.gain.value, context.currentTime);
      gain.gain.linearRampToValueAtTime(0.0001, context.currentTime + FADE);
      source.stop(context.currentTime + FADE + 0.02);
    } catch {}
    source.onended = null;
    source = null;
  }

  function startSource() {
    if (!context || !buffer || source) return;
    try {
      source = context.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      source.connect(gain);
      startedAt = context.currentTime;
      source.start(0, offset % buffer.duration);
      gain.gain.cancelScheduledValues(context.currentTime);
      gain.gain.setValueAtTime(0.0001, context.currentTime);
      gain.gain.linearRampToValueAtTime(
        Math.max(level, 0.0001),
        context.currentTime + FADE,
      );
    } catch {
      source = null;
      failed = true;
    }
  }

  async function apply() {
    if (!enabled || !unlocked || failed) {
      stopSource();
      return;
    }
    if (!makeContext()) return;
    if (context.state !== "running") {
      try {
        await context.resume();
      } catch {}
    }
    // Still blocked: a browser wants a real gesture first. Leave everything
    // armed so the next unlock() call picks up where this one stopped.
    if (context.state !== "running") return;
    await decode();
    if (!enabled || !unlocked || failed || context.state !== "running") return;
    startSource();
  }

  return {
    // Called from any real user gesture; browsers block audio before one.
    unlock() {
      if (unlocked) {
        if (enabled) void apply();
        return;
      }
      unlocked = true;
      makeContext();
      void apply();
    },
    get volume() {
      return base ? level / base : 0;
    },
    // Live: a slider drag retargets the running source without restarting it.
    setVolume(value) {
      level = base * clampTrim(value, base ? level / base : 0);
      if (!gain || !context) return level;
      try {
        gain.gain.cancelScheduledValues(context.currentTime);
        gain.gain.setTargetAtTime(
          source ? Math.max(level, 0.0001) : 0.0001,
          context.currentTime,
          0.02,
        );
      } catch {}
      return level;
    },
    setEnabled(value) {
      const next = Boolean(value);
      if (next === enabled) return;
      enabled = next;
      if (!enabled) stopSource();
      else void apply();
    },
    // "playing" is what the shell mirrors onto <body data-music> so the state
    // is observable without reaching into Web Audio internals.
    get state() {
      if (failed) return "unavailable";
      if (!enabled) return "muted";
      if (source && context && context.state === "running") return "playing";
      if (!unlocked || !context || context.state !== "running")
        return "waiting";
      return "loading";
    },
    get contextState() {
      return context?.state || "none";
    },
    // True only when a browser is still withholding the AudioContext: enabled,
    // asked to play, and stuck because no real gesture has landed yet. The
    // title screen's "press a key" hint keys off this, so it must never be
    // true when audio is simply muted or unavailable.
    get blocked() {
      return (
        enabled && !failed && (!context || context.state !== "running")
      );
    },
  };
}
