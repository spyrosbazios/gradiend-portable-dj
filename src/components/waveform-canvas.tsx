import { memo, useEffect, useRef, useState } from "react";
import { motion, useMotionValue, useSpring, useTransform } from "framer-motion";
import { formatTime, type CueSpot, type DeckId } from "@/core/dj-math";
import { useTheme } from "@/hooks/use-theme";
import { cn } from "@/lib/utils";

interface WaveformCanvasProps {
  deckId: DeckId;
  peaks: number[];
  loading: boolean;
  progress: number;
  duration?: number;
  spots?: CueSpot[];
  flagSec?: number | null;
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

function drawFlagOverlay(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  flagSec: number | null | undefined,
  duration: number,
  brandColor: string,
) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);

  if (flagSec === null || flagSec === undefined || duration <= 0 || !brandColor) return;
  const ratio = Math.min(1, Math.max(0, flagSec / duration));
  const x = Math.min(width - 2, Math.max(2, ratio * width));

  ctx.fillStyle = brandColor;
  ctx.globalAlpha = 0.95;
  ctx.beginPath();
  ctx.roundRect(x - 1.5, 0, 3, height, 1.5);
  ctx.fill();
}

function drawCueDots(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  spots: CueSpot[],
  flagSec: number | null | undefined,
  duration: number,
  colors: { up: string; warn: string; down: string; brand: string },
) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);

  if (spots.length === 0 || duration <= 0) return;

  const radius = spots.length > 24 ? 2.5 : 3.5;
  const cy = height / 2;

  for (const spot of spots) {
    const ratio = Math.min(1, Math.max(0, spot.sec / duration));
    const cx = Math.min(width - radius - 2, Math.max(radius + 2, ratio * width));
    const fill =
      spot.quality === "good"
        ? colors.up
        : spot.quality === "risky"
          ? colors.down
          : colors.warn;

    const isFlagged =
      flagSec !== null && flagSec !== undefined && Math.abs(spot.sec - flagSec) < 0.15;

    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.globalAlpha = isFlagged ? 1 : 0.85;
    ctx.fill();

    if (isFlagged && colors.brand) {
      ctx.beginPath();
      ctx.arc(cx, cy, radius + 1.5, 0, Math.PI * 2);
      ctx.strokeStyle = colors.brand;
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = 1;
      ctx.stroke();
    }
  }
}

export const WaveformCanvas = memo(function WaveformCanvas({
  deckId,
  peaks,
  loading,
  progress,
  duration = 0,
  spots,
  flagSec,
  locked,
  hasTrack,
  onSeek,
}: WaveformCanvasProps) {
  const baseCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const activeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const flagCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const dotsCanvasRef = useRef<HTMLCanvasElement | null>(null);
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

  // While scrubbing, the playhead follows the finger 1:1 and playback progress is ignored;
  // the seek is committed once, on release, so the engine (and the idle deck's entry point)
  // sees one intentional position instead of a burst of intermediate ones.
  const [scrubRatio, setScrubRatio] = useState<number | null>(null);
  const scrubbing = scrubRatio !== null;

  useEffect(() => {
    if (scrubbing) return;
    rawProgress.set(Math.min(1, Math.max(0, progress)));
  }, [progress, rawProgress, scrubbing]);

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

  useEffect(() => {
    const flagCanvas = flagCanvasRef.current;
    const dotsCanvas = dotsCanvasRef.current;
    const container = containerRef.current;
    if (!container) return;

    const renderCues = () => {
      const width = container.clientWidth;
      const waveHeight = container.clientHeight;
      if (width <= 0 || waveHeight <= 0) return;

      const styles = getComputedStyle(document.documentElement);
      const colors = {
        up: styles.getPropertyValue("--app-up").trim(),
        warn: styles.getPropertyValue("--app-warn").trim(),
        down: styles.getPropertyValue("--app-down").trim(),
        brand: styles.getPropertyValue("--app-brand").trim(),
      };

      if (flagCanvas) {
        drawFlagOverlay(
          flagCanvas,
          width,
          waveHeight,
          hasTrack ? flagSec : null,
          duration,
          colors.brand,
        );
      }
      if (dotsCanvas) {
        const dotHeight = dotsCanvas.clientHeight || 14;
        drawCueDots(
          dotsCanvas,
          width,
          dotHeight,
          hasTrack && spots ? spots : [],
          flagSec,
          duration,
          colors,
        );
      }
    };

    renderCues();
    const ro = new ResizeObserver(renderCues);
    ro.observe(container);
    return () => ro.disconnect();
  }, [hasTrack, spots, flagSec, duration, theme]);

  const canScrub = hasTrack && !locked;

  const ratioAt = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  };

  const scrubTo = (ratio: number) => {
    setScrubRatio(ratio);
    rawProgress.set(ratio);
    smoothProgress.jump(ratio);
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!canScrub || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    scrubTo(ratioAt(e));
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!scrubbing || !e.currentTarget.hasPointerCapture(e.pointerId)) return;
    scrubTo(ratioAt(e));
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!scrubbing) return;
    const ratio = ratioAt(e);
    setScrubRatio(null);
    onSeek(ratio);
  };

  const handlePointerCancel = () => {
    if (!scrubbing) return;
    setScrubRatio(null);
    rawProgress.set(Math.min(1, Math.max(0, progress)));
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!canScrub) return;
    const step = e.shiftKey ? 0.1 : 0.02;
    if (e.key === "ArrowRight") onSeek(Math.min(1, progress + step));
    else if (e.key === "ArrowLeft") onSeek(Math.max(0, progress - step));
    else if (e.key === "Home") onSeek(0);
    else return;
    e.preventDefault();
  };

  return (
    <div className="flex w-full flex-col gap-1">
      <div
        ref={containerRef}
        role="slider"
        aria-label={`Deck ${deckId} waveform`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress * 100)}
        aria-valuetext={duration > 0 ? formatTime((scrubRatio ?? progress) * duration) : undefined}
        tabIndex={canScrub ? 0 : -1}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onLostPointerCapture={handlePointerCancel}
        onKeyDown={handleKeyDown}
        className={cn(
          "relative h-16 w-full overflow-hidden rounded-lg border bg-bg/70 transition-[border-color,box-shadow] duration-150 select-none",
          canScrub ? "touch-none cursor-grab" : "touch-pan-y",
          scrubbing ? "cursor-grabbing border-fg/40 shadow-md" : "border-line",
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

        <canvas
          ref={flagCanvasRef}
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 block h-full w-full"
        />

        {hasTrack && (
          <motion.div
            style={{ left: playheadLeft }}
            animate={{ width: scrubbing ? 3 : 2 }}
            className="pointer-events-none absolute top-0.5 bottom-0.5 -translate-x-1/2 rounded-full bg-fg shadow-xs"
          >
            {scrubbing && duration > 0 && (
              <motion.span
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                className="absolute top-1 left-1/2 -translate-x-1/2 rounded bg-fg px-1.5 py-0.5 font-mono text-[10px] font-semibold text-bg tabular-nums shadow"
              >
                {formatTime(scrubRatio * duration)}
              </motion.span>
            )}
          </motion.div>
        )}

        {hasTrack && loading && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-bg/40 text-xs text-dim">
            Loading…
          </div>
        )}

      </div>

      <canvas
        ref={dotsCanvasRef}
        aria-hidden="true"
        className="block h-3.5 w-full"
      />
    </div>
  );
});
