// Laptop microphone as a stand-in for the G2 microphone: the same 16 kHz mono
// s16le bytes, in the same ~100 ms (3200-byte) chunks the simulator sends.
//
// An AudioWorklet copies input frames off the audio thread. Its source is
// inlined as a Blob URL so the fallback needs no extra file in the build. The
// worklet batches 128-frame render quanta before posting, and the main thread
// resamples and cuts exact 3200-byte chunks.

import { Resampler16k } from './pcm-convert.ts';

const CHUNK_BYTES = 3200;
const WORKLET_NAME = 'parley-mic-capture';
const BATCH_FRAMES = 2048;

const WORKLET_SOURCE = `
class ParleyMicCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.batch = new Float32Array(${BATCH_FRAMES});
    this.filled = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    let offset = 0;
    while (offset < channel.length) {
      const take = Math.min(channel.length - offset, this.batch.length - this.filled);
      this.batch.set(channel.subarray(offset, offset + take), this.filled);
      this.filled += take;
      offset += take;
      if (this.filled === this.batch.length) {
        this.port.postMessage(this.batch, [this.batch.buffer]);
        this.batch = new Float32Array(${BATCH_FRAMES});
        this.filled = 0;
      }
    }
    return true;
  }
}
registerProcessor('${WORKLET_NAME}', ParleyMicCapture);
`;

export async function startBrowserMic(onPcm: (bytes: Uint8Array) => void): Promise<{ stop(): void }> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      // Gain control lifts the noise floor during silences, which defeats the
      // pause detector's calibrated threshold.
      autoGainControl: false,
    },
  });
  const context = new AudioContext();
  try {
    const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }));
    try {
      await context.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    const source = context.createMediaStreamSource(stream);
    const capture = new AudioWorkletNode(context, WORKLET_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      // Explicit mono downmixes a stereo microphone instead of dropping a channel.
      channelCount: 1,
      channelCountMode: 'explicit',
    });
    const resampler = new Resampler16k(context.sampleRate);
    const pending = new Uint8Array(CHUNK_BYTES);
    let filled = 0;

    capture.port.onmessage = (event: MessageEvent<Float32Array>) => {
      const bytes = resampler.push(event.data);
      let offset = 0;
      while (offset < bytes.length) {
        const take = Math.min(bytes.length - offset, CHUNK_BYTES - filled);
        pending.set(bytes.subarray(offset, offset + take), filled);
        filled += take;
        offset += take;
        if (filled === CHUNK_BYTES) {
          onPcm(pending.slice());
          filled = 0;
        }
      }
    };

    // The worklet writes no output, so this connection is silent; it keeps the
    // node in the rendered graph, which some browsers require to call process().
    source.connect(capture);
    capture.connect(context.destination);
    if (context.state === 'suspended') await context.resume();

    let stopped = false;
    return {
      stop() {
        if (stopped) return;
        stopped = true;
        capture.port.onmessage = null;
        source.disconnect();
        capture.disconnect();
        for (const track of stream.getTracks()) track.stop();
        void context.close();
      },
    };
  } catch (err) {
    for (const track of stream.getTracks()) track.stop();
    void context.close();
    throw err;
  }
}
