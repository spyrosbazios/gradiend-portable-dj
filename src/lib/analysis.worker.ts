import { analyzeTrackCues, type TrackCues } from "@/core/dj-math";

interface AnalysisRequest {
  id: number;
  samples: Float32Array;
  sampleRate: number;
}

export interface AnalysisWorkerResponse {
  id: number;
  bpm: number | null;
  cues: TrackCues;
}

self.addEventListener("message", (event: MessageEvent<AnalysisRequest>) => {
  const { id, samples, sampleRate } = event.data;
  const { bpm, cues } = analyzeTrackCues(samples, sampleRate);
  const response: AnalysisWorkerResponse = { id, bpm, cues };
  self.postMessage(response);
});
