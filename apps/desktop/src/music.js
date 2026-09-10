// Looping soundtrack for the game.
//
// packages/presentation/src/audio.js is procedural Web Audio only, so streamed
// music lives here instead. A decoded
// AudioBuffer is used rather than <audio>, because the element re-opens the
// decoder at a loop point and leaves an audible gap; a buffer source is
// sample-accurate.
//
// This is a playlist, not a single track: it plays through apps/desktop/src/
// playlist.js in order, advances when a track ends, and wraps at the end, so
// playback is continuous across pauses and menus the same way one looping
// track used to be. A one-track playlist still loops the buffer itself, which
// is the only way to keep that case seamless.
//
// Only the current track is held decoded. A three-minute stereo track is tens
// of megabytes as float PCM, so caching all six would cost hundreds of
// megabytes of resident memory for no benefit.
//
// Everything is same-origin, so `default-src 'self'` covers both the fetch and
// the playback with no media-src of its own.

const FADE = 0.35;

function clampTrim(value, fallback) {
  const trim = Number(value);
  if (!Number.isFinite(trim)) return fallback;
  return Math.min(1, Math.max(0, trim));
}

// The tracks are loud masters: they peak near -1.4 dBFS and average about
// -14 dBFS. Effects peak between -8 and -16 dBFS, but they are 140 ms
// transients while music is continuous, so it is the music's *average* that
// decides whether they cut through. -17.7 dB of gain puts the soundtrack's
// mean at about -32 dBFS and its peaks at about -19 dBFS: under every effect,
// still clearly present underneath the game.
// `volume` is that tuned level and stays the ceiling; the player's music
// slider is a 0..1 trim on top of it, so the balance against the effects bus
// survives any setting.
export function createMusic({
  tracks = [],
  resolve = (track) => track.file,
  volume = 0.13,
  trim = 1,
} = {}) {
  const base = volume;
  const playlist = tracks.filter((track) => track && track.file);
  let level = base * clampTrim(trim, 1),
    context = null,
    gain = null,
    // A passive tap on the music bus for the court's ambience. It is fed from
    // the same gain the speakers hear, so muting or pulling the slider down
    // takes the visuals down with it, and nothing is connected onward from it:
    // an AnalyserNode is a measuring point, not a stage in the signal path.
    analyser = null,
    analyserData = null,
    source = null,
    buffer = null,
    loading = null,
    // Which track `buffer` and `loading` belong to, so a skip that lands
    // mid-decode cannot adopt the previous track's audio.
    loaded = -1,
    index = 0,
    enabled = false,
    unlocked = false,
    failed = false,
    // Set when a track's own fetch or decode fails. The playlist steps past it
    // rather than going silent; only running out of playable tracks is fatal.
    dead = new Set(),
    offset = 0,
    startedAt = 0;

  const current = () => playlist[index] || null;

  function makeContext() {
    if (context) return context;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    try {
      context = new Ctor();
      gain = context.createGain();
      gain.gain.value = 0;
      gain.connect(context.destination);
      try {
        analyser = context.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0.8;
        // Float samples, not bytes: this bus runs at about 0.13, so a whole
        // passage of music moves a byte reading by only a handful of counts
        // and quantises to nothing during a fade.
        analyserData = new Float32Array(analyser.fftSize);
        gain.connect(analyser);
      } catch {
        // No analyser is not a reason to lose the soundtrack; the ambience
        // falls back to its idle animation.
        analyser = null;
      }
    } catch {
      context = null;
      failed = true;
    }
    return context;
  }

  async function decode() {
    if (failed || !playlist.length) return null;
    if (buffer && loaded === index) return buffer;
    const wanted = index,
      track = current();
    if (!track) return null;
    loading = (async () => {
      const response = await fetch(resolve(track));
      if (!response.ok) throw new Error(`music ${response.status}`);
      const bytes = await response.arrayBuffer();
      return await context.decodeAudioData(bytes);
    })()
      .then((decoded) => {
        // A skip landed while this was in flight: the result belongs to a
        // track nobody is waiting for any more.
        if (wanted !== index) return null;
        buffer = decoded;
        loaded = wanted;
        return decoded;
      })
      .catch(() => {
        // One bad file must not silence the other five.
        dead.add(wanted);
        if (dead.size >= playlist.length) failed = true;
        return null;
      });
    return loading;
  }

  function stopSource({ keepPosition = true } = {}) {
    if (!source) return;
    // Remember where the track was so a mute/unmute does not restart it.
    if (keepPosition && context && buffer)
      offset = (context.currentTime - startedAt + offset) % buffer.duration;
    else offset = 0;
    // Cleared before stop() so the natural-end handler cannot fire for a
    // deliberate stop and walk the playlist on unmute or on a skip.
    source.onended = null;
    try {
      gain.gain.cancelScheduledValues(context.currentTime);
      gain.gain.setValueAtTime(gain.gain.value, context.currentTime);
      gain.gain.linearRampToValueAtTime(0.0001, context.currentTime + FADE);
      source.stop(context.currentTime + FADE + 0.02);
    } catch {}
    source = null;
  }

  // Moves to another track and starts it from the top. The buffer is released
  // with it: only the playing track is worth holding decoded.
  function goto(next) {
    if (!playlist.length) return;
    stopSource({ keepPosition: false });
    index = ((next % playlist.length) + playlist.length) % playlist.length;
    buffer = null;
    loaded = -1;
    loading = null;
    offset = 0;
  }

  function startSource() {
    if (!context || !buffer || source) return;
    try {
      const playing = index;
      source = context.createBufferSource();
      source.buffer = buffer;
      // A single-track playlist keeps the seamless looping source it always
      // had. With more than one track the source has to end for the next to be
      // scheduled, and the playlist itself supplies the continuity.
      source.loop = playlist.length <= 1;
      source.connect(gain);
      startedAt = context.currentTime;
      source.onended = () => {
        // A natural end, and only for the track still selected: stopSource()
        // clears this handler, so a mute, a skip or a track change can never
        // advance the playlist twice.
        if (playing !== index) return;
        source = null;
        goto(index + 1);
        void apply();
      };
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
    if (!enabled || !unlocked || failed || !playlist.length) {
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
    // A track that would not load is stepped over rather than stalling the
    // playlist. The bound is the playlist length, so an all-bad playlist ends
    // as `failed` instead of spinning.
    for (let attempt = 0; attempt < playlist.length; attempt++) {
      if (dead.has(index)) {
        goto(index + 1);
        continue;
      }
      const decoded = await decode();
      if (decoded) break;
      if (failed) return;
      goto(index + 1);
    }
    if (
      !buffer ||
      !enabled ||
      !unlocked ||
      failed ||
      context.state !== "running"
    )
      return;
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
    // The playlist, for the player UI. Skipping while the music is off or
    // still blocked simply moves the selection: the next unlock or unmute
    // starts from the track the player chose.
    get trackTitle() {
      return current()?.title || "";
    },
    get trackIndex() {
      return playlist.length ? index : -1;
    },
    get trackCount() {
      return playlist.length;
    },
    skip(step = 1) {
      if (!playlist.length) return;
      goto(index + (Number(step) || 1));
      void apply();
    },
    // "playing" is what the shell mirrors onto <body data-music> so the state
    // is observable without reaching into Web Audio internals.
    get state() {
      if (failed || !playlist.length) return "unavailable";
      if (!enabled) return "muted";
      if (source && context && context.state === "running") return "playing";
      if (!unlocked || !context || context.state !== "running")
        return "waiting";
      return "loading";
    },
    // 0..1 loudness of what is playing right now, or null when there is
    // nothing to measure — muted, off, still loading, or blocked by autoplay.
    // Null is the signal to fall back to an idle animation rather than
    // freezing on a stale value. The reading is normalised against the current
    // level so the picture does not dim when the player turns the music down;
    // the mute path still returns null, and a slider at zero has no source to
    // report on either.
    get energy() {
      if (!analyser || !analyserData || !source || !context) return null;
      if (context.state !== "running" || !enabled || failed) return null;
      try {
        analyser.getFloatTimeDomainData(analyserData);
      } catch {
        return null;
      }
      let sum = 0;
      for (const sample of analyserData) sum += sample * sample;
      const rms = Math.sqrt(sum / analyserData.length);
      if (!Number.isFinite(rms)) return null;
      // The tracks average about -14 dBFS before this bus's own -17.7 dB, so a
      // full-blooded passage lands near 0.03 RMS at level 0.13. Scaling by the
      // live level keeps that true at any slider position.
      const reference = Math.max(level, 0.0001) * 0.25;
      return Math.min(1, rms / reference);
    },
    get contextState() {
      return context?.state || "none";
    },
    // True only when a browser is still withholding the AudioContext: enabled,
    // asked to play, and stuck because no real gesture has landed yet. The
    // title screen's "press a key" hint keys off this, so it must never be
    // true when audio is simply muted or unavailable.
    get blocked() {
      return enabled && !failed && (!context || context.state !== "running");
    },
  };
}
