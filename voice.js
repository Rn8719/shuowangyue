'use strict';

const recordedClips = typeof recordedVoice === 'undefined' ? {} : recordedVoice.cues;
const tauntClips = new Map([
  ['呵呵打的不错哟', 'taunt-1'], ['干得漂亮', 'taunt-2'], ['差距自己找，重开右上角', 'taunt-3'],
  ['easy', 'taunt-4'], ['就这？就这？', 'taunt-5'], ['有真人吗？', 'taunt-6'],
  ['别浪费我的流量了好吗', 'taunt-7']
]);

const voiceSamples = new WeakMap();

function makeRecordedAudio(context, text) {
  const cue = recordedClips[tauntClips.get(text)];
  return cue ? makePCMPlayback(context, recordedVoice, cue) : null;
}

function makeVictoryAudio(context) {
  if (typeof victoryRecording === 'undefined') return null;
  return makePCMPlayback(context, victoryRecording, victoryRecording.cue);
}

function makePCMPlayback(context, recording, cue) {
  if (!context) return null;
  let source;
  let started = false;
  let cancelled = false;
  const playback = {
    async play() {
      if (context.state !== 'running') await context.resume();
      if (cancelled) return;
      let samples = voiceSamples.get(recording);
      if (!samples) {
        const bytes = atob(recording.pcm);
        samples = new Float32Array(bytes.length / 2);
        for (let index = 0; index < samples.length; index++) {
          const value = bytes.charCodeAt(index * 2) | (bytes.charCodeAt(index * 2 + 1) << 8);
          samples[index] = (value > 32767 ? value - 65536 : value) / 32768;
        }
        voiceSamples.set(recording, samples);
      }
      const [start, length] = cue;
      const buffer = context.createBuffer(1, length, recording.rate);
      buffer.getChannelData(0).set(samples.subarray(start, start + length));
      source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      source.onended = () => {
        if (!cancelled) playback.onended?.();
      };
      source.start();
      started = true;
      playback.onplaying?.();
    },
    pause() {
      cancelled = true;
      if (source) {
        source.onended = null;
        if (started) source.stop();
        source.disconnect();
      }
    }
  };
  return playback;
}

function makeSpeechAudio(synthesis, createUtterance, text) {
  if (!synthesis || !createUtterance) return null;
  let scheduled;
  let speaking = false;
  const playback = {
    play() {
      scheduled = setTimeout(() => {
        try {
          const utterance = createUtterance(text);
          utterance.lang = 'zh-CN';
          utterance.rate = 1.08;
          utterance.onstart = () => { if (speaking) playback.onplaying?.(); };
          utterance.onend = () => {
            if (!speaking) return;
            speaking = false;
            playback.onended?.();
          };
          utterance.onerror = () => {
            if (!speaking) return;
            speaking = false;
            playback.onerror?.();
          };
          speaking = true;
          synthesis.speak(utterance);
        } catch { playback.onerror?.(); }
      }, 0);
    },
    pause() {
      clearTimeout(scheduled);
      if (!speaking) return;
      speaking = false;
      synthesis.cancel();
    }
  };
  return playback;
}

class TableVoice {
  constructor(makeAudio, onChange) {
    this.makeAudio = makeAudio;
    this.onChange = onChange;
    this.queue = [];
    this.paused = false;
  }

  speak(text, onStart) {
    return new Promise(resolve => {
      this.queue.push({ text, onStart, resolve, shown: false });
      this.play();
    });
  }

  show(entry) {
    if (entry.shown) return;
    entry.shown = true;
    entry.onStart?.();
  }

  play() {
    const entry = this.queue[0];
    if (this.paused || this.audio || !entry) {
      this.onChange(!this.paused && Boolean(this.audio));
      return;
    }
    const audio = this.makeAudio(entry.text);
    if (!audio) return this.finish();
    this.audio = audio;
    this.onChange(true);
    audio.onplaying = () => {
      if (this.audio === audio) this.show(entry);
    };
    const fail = () => {
      if (this.audio === audio) this.finish();
    };
    audio.onerror = fail;
    audio.onended = fail;
    this.watchdog = setTimeout(fail, 15000);
    try { Promise.resolve(audio.play()).catch(fail); } catch { fail(); }
  }

  releaseAudio() {
    clearTimeout(this.watchdog);
    const audio = this.audio;
    this.audio = null;
    audio?.pause();
  }

  finish() {
    this.releaseAudio();
    const entry = this.queue.shift();
    if (entry) {
      this.show(entry);
      entry.resolve();
    }
    this.play();
  }

  pause() {
    this.paused = true;
    this.releaseAudio();
    this.onChange(false);
  }

  resume() {
    this.paused = false;
    this.play();
  }

  skip() {
    if (!this.paused && this.queue.length) this.finish();
  }

  reset() {
    this.releaseAudio();
    this.paused = false;
    for (const entry of this.queue.splice(0)) entry.resolve();
    this.onChange(false);
  }
}
