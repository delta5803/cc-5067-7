// Real Web Audio playback of rendered Float64 buffers (converted to AudioBuffer).
// Source switching preserves the playhead because every render has equal length.

export class Player {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.buffers = {};
    this.current = 'stage';
    this.playing = false;
    this.offset = 0;
    this.startCtxTime = 0;
    this.src = null;
    this.raf = 0;
    this.onTick = null;
    this.onPlayState = null;
  }

  async ensureContext() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.95;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    return this.ctx;
  }

  setBuffers(map, sampleRate) {
    this.sampleRate = sampleRate;
    for (const [key, st] of Object.entries(map)) {
      if (!st) continue;
      const len = st.L.length;
      const buf = this.ctx ? this.ctx.createBuffer(2, len, sampleRate) : null;
      if (buf) {
        buf.getChannelData(0).set(st.L);
        buf.getChannelData(1).set(st.R || st.L);
      }
      this.buffers[key] = buf;
    }
    // If no context yet, mark raw and build lazily on play.
    this._raw = map;
  }

  async _buildBuffersIfNeeded() {
    await this.ensureContext();
    if (this._raw) {
      for (const [key, st] of Object.entries(this._raw)) {
        if (!st || this.buffers[key]) continue;
        const buf = this.ctx.createBuffer(2, st.L.length, this.sampleRate);
        buf.getChannelData(0).set(st.L);
        buf.getChannelData(1).set(st.R || st.L);
        this.buffers[key] = buf;
      }
    }
  }

  get duration() {
    const b = this.buffers[this.current];
    return b ? b.duration : 0;
  }

  getTime() {
    if (this.playing && this.ctx) {
      const t = this.offset + (this.ctx.currentTime - this.startCtxTime);
      return Math.min(t, this.duration);
    }
    return this.offset;
  }

  async select(key, autoplay = false) {
    const keepTime = this.getTime();
    const wasPlaying = this.playing;
    this._stopNode();
    this.current = key;
    this.offset = Math.min(keepTime, this.duration || keepTime);
    if (wasPlaying || autoplay) await this._start();
    this._emitState();
  }

  async togglePlay() {
    if (this.playing) {
      this.pause();
    } else {
      await this._start();
    }
  }

  async playSource(key) {
    if (key && key !== this.current) {
      await this.select(key, true);
    } else {
      await this._start();
    }
  }

  pause() {
    if (this.playing) this.offset = this.getTime();
    this._stopNode();
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this._emitState();
  }

  async _start() {
    await this._buildBuffersIfNeeded();
    const buf = this.buffers[this.current];
    if (!buf) return;
    if (this.offset >= buf.duration - 0.02) this.offset = 0;
    this._stopNode();
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.master);
    const startOffset = this.offset;
    src.onended = () => {
      if (this.src === src && this.playing) {
        this.playing = false;
        this.offset = 0;
        cancelAnimationFrame(this.raf);
        this._emitState();
      }
    };
    src.start(0, startOffset);
    this.src = src;
    this.startCtxTime = this.ctx.currentTime;
    this.offset = startOffset;
    this.playing = true;
    cancelAnimationFrame(this.raf);
    const tick = () => {
      if (!this.playing) return;
      if (this.onTick) this.onTick(this.getTime(), this.duration);
      if (this.getTime() >= this.duration - 0.01) {
        this.pause();
        this.offset = 0;
        if (this.onTick) this.onTick(0, this.duration);
        return;
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
    this._emitState();
  }

  _stopNode() {
    if (this.src) {
      const s = this.src;
      s.onended = null;
      try { s.stop(); } catch { /* already stopped */ }
      try { s.disconnect(); } catch { /* noop */ }
      this.src = null;
    }
  }

  seekFraction(frac) {
    const t = Math.max(0, Math.min(1, frac)) * (this.duration || 0);
    const was = this.playing;
    this.offset = t;
    this._stopNode();
    this.playing = false;
    if (was) this._start();
    this._emitState();
  }

  // Re-render replaced buffers: restart quietly at the same position if playing.
  async refreshBuffers(map, sampleRate) {
    const t = this.getTime();
    const was = this.playing;
    this.pause();
    this.setBuffers(map, sampleRate);
    this.offset = Math.min(t, this.duration || t);
    if (was) await this._start();
  }

  _emitState() {
    if (this.onPlayState) this.onPlayState(this.playing, this.current);
  }
}

export function formatTime(sec) {
  if (!Number.isFinite(sec)) sec = 0;
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return m + ':' + s.toFixed(1).padStart(4, '0');
}
