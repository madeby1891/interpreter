// audio-worklet.js — downsample the mic to 16 kHz mono Int16 PCM.
//
// Runs on the audio render thread. Takes the device's native-rate Float32
// frames (usually 48 kHz), linearly resamples to 16 kHz, converts to Int16,
// and posts ~100 ms chunks back to the main thread, which forwards them to the
// table's mic socket. Raw PCM (no container/codec) makes this work identically
// on every browser — phones included.

class PcmDownsampler extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.targetRate = opts.targetRate || 16000;
    this.inRate = sampleRate; // global: the AudioContext's sample rate
    this.step = this.inRate / this.targetRate;
    this.buf = new Float32Array(0);
    this.readPos = 0;
    // Emit roughly every 100 ms of output audio.
    this.flushEvery = Math.max(1, Math.round(this.targetRate * 0.1));
    this.out = new Float32Array(this.flushEvery);
    this.outLen = 0;
  }

  process(inputs) {
    const chan = inputs[0] && inputs[0][0];
    if (!chan || chan.length === 0) return true;

    // Append the new frame to whatever's left unconsumed.
    const merged = new Float32Array(this.buf.length - this.readPos + chan.length);
    merged.set(this.buf.subarray(this.readPos));
    merged.set(chan, this.buf.length - this.readPos);
    this.buf = merged;
    this.readPos = 0;

    // Resample by linear interpolation until we'd run past the end.
    let pos = 0;
    const last = this.buf.length - 1;
    while (pos + this.step <= last) {
      const i0 = Math.floor(pos);
      const frac = pos - i0;
      const s = this.buf[i0] * (1 - frac) + this.buf[i0 + 1] * frac;
      this.out[this.outLen++] = s;
      if (this.outLen >= this.flushEvery) this.flush();
      pos += this.step;
    }
    this.readPos = Math.floor(pos);
    return true;
  }

  flush() {
    if (this.outLen === 0) return;
    const pcm = new Int16Array(this.outLen);
    let sum = 0;
    for (let i = 0; i < this.outLen; i++) {
      let v = this.out[i];
      if (v > 1) v = 1; else if (v < -1) v = -1;
      pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / this.outLen); // 0..1, for the level meter
    this.port.postMessage({ pcm, rms }, [pcm.buffer]);
    this.outLen = 0;
  }
}

registerProcessor('pcm-downsampler', PcmDownsampler);
