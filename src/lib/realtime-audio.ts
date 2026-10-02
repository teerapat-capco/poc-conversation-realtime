const SAMPLE_RATE = 24_000;
const MAX_BUFFERED_BYTES = 1_000_000;

const workletSource = `
class FoundryRealtimeAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    this.playbackQueue = [];
    this.playbackOffset = 0;
    this.playbackEnabled = true;

    this.captureSamples = [];
    this.captureFrameCount = 0;

    // 200 ms @ 24 kHz
    this.captureChunkFrames = 4800;

    this.port.onmessage = (event) => {
      const message = event.data;

      if (message?.type === "playback") {
        const samples = new Int16Array(message.buffer);

        if (samples.length > 0) {
          this.playbackQueue.push(samples);
        }

        return;
      }

      if (message?.type === "clear-playback") {
        this.playbackQueue = [];
        this.playbackOffset = 0;
        this.playbackEnabled = false;
        return;
      }

      if (message?.type === "enable-playback") {
        this.playbackEnabled = true;
        return;
      }

      if (message?.type === "flush") {
        this.flushCapture();
        this.port.postMessage({ type: "flushed" });
      }
    };
  }

  nextPlaybackSample() {
    if (!this.playbackEnabled) {
      return 0;
    }

    while (this.playbackQueue.length > 0) {
      const current = this.playbackQueue[0];

      if (this.playbackOffset < current.length) {
        const sample = current[this.playbackOffset];
        this.playbackOffset += 1;
        return sample;
      }

      this.playbackQueue.shift();
      this.playbackOffset = 0;
    }

    return 0;
  }

  flushCapture() {
    if (this.captureFrameCount === 0) {
      return;
    }

    const stereo = new Int16Array(this.captureFrameCount * 2);

    for (let i = 0; i < this.captureFrameCount; i += 1) {
      stereo[i * 2] = this.captureSamples[i * 2];
      stereo[i * 2 + 1] = this.captureSamples[i * 2 + 1];
    }

    this.captureSamples = [];
    this.captureFrameCount = 0;

    this.port.postMessage(
      {
        type: "capture",
        buffer: stereo.buffer,
      },
      [stereo.buffer],
    );
  }

  process(inputs, outputs) {
    const mic = inputs[0]?.[0];
    const output = outputs[0]?.[0];

    if (!output) {
      return true;
    }

    for (let i = 0; i < output.length; i += 1) {
      // ----- playback/reference -----

      const referenceInt16 = this.nextPlaybackSample();

      output[i] =
        referenceInt16 < 0
          ? referenceInt16 / 32768
          : referenceInt16 / 32767;

      // ----- microphone -----

      const micFloat = mic?.[i] ?? 0;

      const clamped = Math.max(
        -1,
        Math.min(1, micFloat),
      );

      const micInt16 =
        clamped < 0
          ? Math.round(clamped * 32768)
          : Math.round(clamped * 32767);

      // Interleaved stereo:
      //
      // channel 0 = microphone
      // channel 1 = exact PCM sample rendered by this worklet
      //
      this.captureSamples.push(micInt16);
      this.captureSamples.push(referenceInt16);

      this.captureFrameCount += 1;

      if (
        this.captureFrameCount >=
        this.captureChunkFrames
      ) {
        this.flushCapture();
      }
    }

    return true;
  }
}

registerProcessor(
  "foundry-realtime-audio",
  FoundryRealtimeAudioProcessor,
);
`;

export type RealtimeAudio = {
    enqueuePlayback: (buffer: ArrayBuffer) => void;
    clearPlayback: () => void;
    stop: () => Promise<void>;
};

export async function createRealtimeAudio(
    stream: MediaStream,
    socket: WebSocket,
    onError: (error: Error) => void,
): Promise<RealtimeAudio> {
    const audioContext = new AudioContext({
        sampleRate: SAMPLE_RATE,
    });

    if (audioContext.sampleRate !== SAMPLE_RATE) {
        await audioContext.close();

        throw new Error(
            `Realtime audio requires 24 kHz; browser created ${audioContext.sampleRate} Hz.`,
        );
    }

    if (audioContext.state === "suspended") {
        await audioContext.resume();
    }

    const moduleUrl = URL.createObjectURL(
        new Blob(
            [workletSource],
            { type: "text/javascript" },
        ),
    );

    try {
        await audioContext.audioWorklet.addModule(moduleUrl);
    } finally {
        URL.revokeObjectURL(moduleUrl);
    }

    const microphone =
        audioContext.createMediaStreamSource(stream);

    const processor = new AudioWorkletNode(
        audioContext,
        "foundry-realtime-audio",
        {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [1],
            channelCount: 1,
            channelCountMode: "explicit",
        },
    );

    microphone.connect(processor);
    processor.connect(audioContext.destination);

    let stopped = false;

    processor.port.onmessage = (
        event: MessageEvent<{
            type?: string;
            buffer?: ArrayBuffer;
        }>,
    ) => {
        if (
            event.data.type !== "capture" ||
            !event.data.buffer
        ) {
            return;
        }

        if (stopped) {
            return;
        }

        if (socket.readyState !== WebSocket.OPEN) {
            return;
        }

        if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
            onError(
                new Error(
                    "Audio bridge is not keeping up with realtime audio.",
                ),
            );
            return;
        }

        // Already interleaved:
        // [mic0, ref0, mic1, ref1, ...]
        socket.send(event.data.buffer);
    };

    return {
        enqueuePlayback(buffer: ArrayBuffer) {
            if (stopped || buffer.byteLength === 0) {
                return;
            }

            // Copy because ownership is transferred to AudioWorklet.
            const copy = buffer.slice(0);

            processor.port.postMessage(
                {
                    type: "enable-playback",
                },
            );

            processor.port.postMessage(
                {
                    type: "playback",
                    buffer: copy,
                },
                [copy],
            );
        },

        clearPlayback() {
            if (stopped) {
                return;
            }

            processor.port.postMessage({
                type: "clear-playback",
            });
        },

        async stop() {
            if (stopped) {
                return;
            }

            stopped = true;

            await new Promise<void>((resolve) => {
                const timeout =
                    window.setTimeout(resolve, 500);

                const original =
                    processor.port.onmessage;

                processor.port.onmessage = (event) => {
                    original?.call(processor.port, event);

                    if (
                        (
                            event as MessageEvent<{
                                type?: string;
                            }>
                        ).data.type === "flushed"
                    ) {
                        window.clearTimeout(timeout);
                        resolve();
                    }
                };

                processor.port.postMessage({
                    type: "flush",
                });
            });

            microphone.disconnect();
            processor.disconnect();

            if (audioContext.state !== "closed") {
                await audioContext.close();
            }
        },
    };
}