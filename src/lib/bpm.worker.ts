import { estimateBpm } from "@/core/dj-math";

interface BpmRequest {
  id: number;
  samples: Float32Array;
  sampleRate: number;
}

self.addEventListener("message", (event: MessageEvent<BpmRequest>) => {
  const { id, samples, sampleRate } = event.data;
  const bpm = estimateBpm(samples, sampleRate);
  self.postMessage({ id, bpm });
});
