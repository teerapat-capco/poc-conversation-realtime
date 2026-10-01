const SAMPLE_RATE = 24_000;
const CHUNK_SAMPLES = 4_800;
const MAX_BUFFERED_BYTES = 1_000_000;

const workletSource = `
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Int16Array(${CHUNK_SAMPLES});
    this.offset = 0;
    this.port.onmessage = (event) => {
      if (event.data?.type === "flush") {
        this.sendChunk();
        this.port.postMessage({ type: "flushed" });
      }
    };
  }
  sendChunk() {
    if (this.offset === 0) return;
    const chunk = this.samples.slice(0, this.offset);
    this.port.postMessage({ type: "chunk", buffer: chunk.buffer }, [chunk.buffer]);
    this.offset = 0;
  }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (let index = 0; index < channel.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, channel[index]));
      this.samples[this.offset] = sample < 0 ? sample * 32768 : sample * 32767;
      this.offset += 1;
      if (this.offset === this.samples.length) this.sendChunk();
    }
    return true;
  }
}
registerProcessor("pcm-capture-processor", PcmCaptureProcessor);
`;

export type PcmCapture = { stop: () => Promise<void> };

export async function createPcmCapture(
  stream: MediaStream,
  socket: WebSocket,
  onError: (error: Error) => void,
): Promise<PcmCapture> {
  const audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
  if (audioContext.sampleRate !== SAMPLE_RATE) {
    await audioContext.close();
    throw new Error("This browser could not provide 24 kHz audio capture.");
  }

  const moduleUrl = URL.createObjectURL(new Blob([workletSource], { type: "text/javascript" }));
  try {
    await audioContext.audioWorklet.addModule(moduleUrl);
  } finally {
    URL.revokeObjectURL(moduleUrl);
  }

  const source = audioContext.createMediaStreamSource(stream);
  const processor = new AudioWorkletNode(audioContext, "pcm-capture-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });
  const silentOutput = audioContext.createGain();
  silentOutput.gain.value = 0;
  source.connect(processor);
  processor.connect(silentOutput);
  silentOutput.connect(audioContext.destination);

  let stopped = false;
  processor.port.onmessage = (event: MessageEvent<{ type?: string; buffer?: ArrayBuffer }>) => {
    if (event.data.type !== "chunk" || !event.data.buffer) return;
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      onError(new Error("Audio bridge is not keeping up with microphone input."));
      return;
    }
    socket.send(event.data.buffer);
  };

  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      await new Promise<void>((resolve) => {
        const timeout = window.setTimeout(resolve, 500);
        const original = processor.port.onmessage;
        processor.port.onmessage = (event) => {
          original?.call(processor.port, event);
          if ((event as MessageEvent<{ type?: string }>).data.type === "flushed") {
            window.clearTimeout(timeout);
            resolve();
          }
        };
        processor.port.postMessage({ type: "flush" });
      });
      source.disconnect();
      processor.disconnect();
      silentOutput.disconnect();
      await audioContext.close();
    },
  };
}