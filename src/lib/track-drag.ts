/** Drag payload type for a library track dragged onto a deck. */
export const TRACK_DRAG_MIME = "application/x-portable-dj-track";

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
