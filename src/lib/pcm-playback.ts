const SAMPLE_RATE = 24_000;

export type PcmPlayback = {
    enqueue: (buffer: ArrayBuffer) => void;
    clear: () => void;
    close: () => Promise<void>;
};

export async function createPcmPlayback(): Promise<PcmPlayback> {
    const audioContext = new AudioContext({
        sampleRate: SAMPLE_RATE,
    });

    if (audioContext.sampleRate !== SAMPLE_RATE) {
        await audioContext.close();

        throw new Error(
            `Audio playback requires 24 kHz, browser created ${audioContext.sampleRate} Hz.`,
        );
    }

    let nextStartTime = audioContext.currentTime;
    const activeSources = new Set<AudioBufferSourceNode>();

    function enqueue(pcmBuffer: ArrayBuffer) {
        if (pcmBuffer.byteLength === 0) return;

        const pcm = new Int16Array(pcmBuffer);

        const audioBuffer = audioContext.createBuffer(
            1,
            pcm.length,
            SAMPLE_RATE,
        );

        const channel = audioBuffer.getChannelData(0);

        for (let i = 0; i < pcm.length; i += 1) {
            channel[i] =
                pcm[i] < 0
                    ? pcm[i] / 32768
                    : pcm[i] / 32767;
        }

        const source = audioContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(audioContext.destination);

        const startTime = Math.max(
            audioContext.currentTime,
            nextStartTime,
        );

        source.start(startTime);

        nextStartTime =
            startTime + audioBuffer.duration;

        activeSources.add(source);

        source.onended = () => {
            activeSources.delete(source);
        };
    }

    function clear() {
        for (const source of activeSources) {
            try {
                source.stop();
            } catch {
                // already stopped
            }
        }

        activeSources.clear();
        nextStartTime = audioContext.currentTime;
    }

    return {
        enqueue,

        clear,

        async close() {
            clear();

            if (audioContext.state !== "closed") {
                await audioContext.close();
            }
        },
    };
}