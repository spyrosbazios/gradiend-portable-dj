/** Drag payload type for a library track dragged onto a deck or the queue. */
export const TRACK_DRAG_MIME = "application/x-portable-dj-track";
/** Drag payload type for a queue row (its index) dragged onto a deck. */
export const QUEUE_DRAG_MIME = "application/x-portable-dj-queue-entry";

/** What a deck received: a library track, or a queue row that leaves the queue when loaded. */
export type DeckDrop = { kind: "library"; trackId: string } | { kind: "queue"; index: number };

export function isDeckDrag(e: React.DragEvent): boolean {
  const types = e.dataTransfer.types;
  return types.includes(TRACK_DRAG_MIME) || types.includes(QUEUE_DRAG_MIME);
}

export function readDeckDrop(e: React.DragEvent): DeckDrop | null {
  const queueIndex = e.dataTransfer.getData(QUEUE_DRAG_MIME);
  if (queueIndex !== "") {
    const index = Number(queueIndex);
    return Number.isInteger(index) && index >= 0 ? { kind: "queue", index } : null;
  }
  const trackId = e.dataTransfer.getData(TRACK_DRAG_MIME);
  return trackId ? { kind: "library", trackId } : null;
}

/** Replaces the browser's row snapshot with a compact title chip under the pointer. */
export function setTrackDragImage(e: React.DragEvent, title: string): void {
  const chip = document.createElement("div");
  chip.textContent = title;
  chip.className =
    "fixed -top-96 left-0 max-w-56 truncate rounded-full border border-brand bg-card px-3 py-1.5 text-xs font-semibold text-fg shadow-lg";
  document.body.appendChild(chip);
  e.dataTransfer.setDragImage(chip, 16, 16);
  requestAnimationFrame(() => chip.remove());
}
