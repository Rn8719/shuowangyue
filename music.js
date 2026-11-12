'use strict';

function createTableMusic(context) {
  const sampleRate = 22050;
  const beat = .7;
  const bars = [
    { harmony: [45, 52, 57], melody: [69, 76, 74, 72] },
    { harmony: [41, 48, 53], melody: [72, 69, 67, null] },
    { harmony: [48, 55, 60], melody: [67, 72, 76, 74] },
    { harmony: [43, 50, 55], melody: [74, 71, 67, null] },
    { harmony: [45, 52, 57], melody: [69, 72, 76, 81] },
    { harmony: [41, 48, 53], melody: [79, 76, 72, null] },
    { harmony: [48, 55, 60], melody: [67, 72, 74, 76] },
    { harmony: [43, 50, 55], melody: [74, 71, 69, null] }
  ];
  const buffer = context.createBuffer(1, Math.round(bars.length * 4 * beat * sampleRate), sampleRate);
  const samples = buffer.getChannelData(0);

  function addTone(note, start, duration, volume, plucked) {
    const first = Math.round(start * sampleRate);
    const length = Math.round(duration * sampleRate);
    const angularStep = 2 * Math.PI * 440 * 2 ** ((note - 69) / 12) / sampleRate;
    const attack = plucked ? .022 : .45;
    const release = plucked ? .32 : .75;
    for (let sample = 0; sample < length; sample++) {
      const age = sample / sampleRate;
      const envelope = Math.min(1, age / attack, (duration - age) / release);
      const decay = plucked ? Math.exp(-2.9 * age) : 1;
      const phase = sample * angularStep;
      const tone = Math.sin(phase) + (plucked ? .18 : .06) * Math.sin(phase * 2);
      samples[(first + sample) % samples.length] += tone * envelope * decay * volume;
    }
  }

  bars.forEach(({ harmony, melody }, index) => {
    const start = index * 4 * beat;
    harmony.forEach((note, voice) => addTone(note, start + voice * .09, 4 * beat, .009, false));
    melody.forEach((note, offset) => {
      if (note === null) return;
      addTone(note, start + offset * beat, 1.6, .028, true);
      addTone(note, start + offset * beat + .24, 1.1, .004, true);
    });
  });
  return buffer;
}
