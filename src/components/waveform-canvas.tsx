import { useEffect, useRef } from "react";
import { motion, useMotionValue, useSpring, useTransform } from "framer-motion";
import { Lock } from "lucide-react";
import type { DeckId } from "@/core/dj-math";
import { useTheme } from "@/hooks/use-theme";
import { cn } from "@/lib/utils";

interface WaveformCanvasProps {
  deckId: DeckId;
  peaks: number[];
  loading: boolean;
  progress: number;
  locked: boolean;
  hasTrack: boolean;
  onSeek: (ratio: number) => void;
}

function drawBars(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  peaks: number[],
  color: string,
  alpha: number,
) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);

  const barCount = peaks.length || 80;
  const gap = 2;
  const barW = Math.max(1.5, (width - gap * (barCount - 1)) / barCount);
  const midY = height / 2;

  ctx.fillStyle = color;
  ctx.globalAlpha = peaks.length > 0 ? alpha : 0.22;

  for (let i = 0; i < barCount; i++) {
    const amp = peaks.length > 0 ? (peaks[i] ?? 0.1) : 0.14;
    const barH = Math.max(4, amp * (height - 10));
    const x = i * (barW + gap);
    const y = midY - barH / 2;
    ctx.beginPath();
    ctx.roundRect(x, y, barW, barH, 1.5);
    ctx.fill();
  }
}

export function WaveformCanvas({
  deckId,
  peaks,
  loading,
  progress,
  locked,
  hasTrack,
  onSeek,
}: WaveformCanvasProps) {
  const baseCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const activeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const { theme } = useTheme();

  const rawProgress = useMotionValue(progress);
  const smoothProgress = useSpring(rawProgress, {
    stiffness: 380,
    damping: 36,
    mass: 0.45,
  });

  const clipPath = useTransform(
    smoothProgress,
    (v) => `inset(0 ${Math.max(0, Math.min(100, (1 - v) * 100))}% 0 0)`,
  );
  const playheadLeft = useTransform(
    smoothProgress,
    (v) => `${Math.max(0, Math.min(100, v * 100))}%`,
  );

  useEffect(() => {
    rawProgress.set(Math.min(1, Math.max(0, progress)));
  }, [progress, rawProgress]);

  useEffect(() => {
    const baseCanvas = baseCanvasRef.current;
    const activeCanvas = activeCanvasRef.current;
    const container = containerRef.current;
    if (!baseCanvas || !activeCanvas || !container) return;

    const render = () => {
      const width = container.clientWidth;
      const height = container.clientHeight;
      if (width <= 0 || height <= 0) return;

      const styles = getComputedStyle(document.documentElement);
      const activeColor = styles
        .getPropertyValue(deckId === "A" ? "--app-deckA" : "--app-deckB")
        .trim();
      const unplayedColor = styles.getPropertyValue("--app-faint").trim();

      drawBars(baseCanvas, width, height, peaks, unplayedColor, 0.4);
      drawBars(activeCanvas, width, height, peaks, activeColor, 0.95);
    };

    render();
    const ro = new ResizeObserver(render);
    ro.observe(container);
    return () => ro.disconnect();
  }, [deckId, peaks, theme]);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!hasTrack || locked) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    onSeek(Math.min(1, Math.max(0, ratio)));
  };

  return (
    <div
      ref={containerRef}
      role="slider"
      aria-label={`Deck ${deckId} waveform`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(progress * 100)}
      tabIndex={hasTrack && !locked ? 0 : -1}
      onPointerDown={handlePointerDown}
      className={cn(
        "relative h-16 w-full overflow-hidden rounded-lg border border-line bg-bg/70 select-none",
        hasTrack && !locked && "cursor-pointer",
        locked && "cursor-not-allowed",
      )}
    >
      <canvas ref={baseCanvasRef} className="block h-full w-full" />

      <motion.div
        style={{ clipPath }}
        className="pointer-events-none absolute inset-0"
      >
        <canvas ref={activeCanvasRef} className="block h-full w-full" />
      </motion.div>

      {hasTrack && (
        <motion.div
          style={{ left: playheadLeft }}
          className="pointer-events-none absolute top-0.5 bottom-0.5 w-0.5 -translate-x-1/2 rounded-full bg-fg shadow-xs"
        />
      )}

      {hasTrack && loading && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-bg/40 text-xs text-dim">
          Loading…
        </div>
      )}

      {hasTrack && locked && (
        <div
          aria-label="Waveform locked"
          className="pointer-events-none absolute right-2 bottom-1.5 flex items-center rounded-md bg-card/90 p-1 text-dim"
        >
          <Lock className="size-3" />
        </div>
      )}
    </div>
  );
}
