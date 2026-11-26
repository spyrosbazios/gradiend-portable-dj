import { memo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Link2, Loader2, Plus, Trash2, Upload, Volume2 } from "lucide-react";
import { toast } from "sonner";
import {
  MAX_SOUND_PADS,
  importFromMyInstants,
  importLocalSoundFile,
  type SoundPad,
} from "@/lib/soundboard";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

interface SoundboardBarProps {
  pads: SoundPad[];
  activePadIds: Set<string>;
  onTriggerPad: (pad: SoundPad) => void;
  onAddPad: (pad: SoundPad) => void;
  onRemovePad: (padId: string) => void;
}

export const SoundboardBar = memo(function SoundboardBar({
  pads,
  activePadIds,
  onTriggerPad,
  onAddPad,
  onRemovePad,
}: SoundboardBarProps) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [customLabel, setCustomLabel] = useState("");
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const canAddMore = pads.length < MAX_SOUND_PADS;

  const handleImportUrl = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim() || !canAddMore) return;
    setImporting(true);
    try {
      const pad = await importFromMyInstants(url, customLabel);
      onAddPad(pad);
      setUrl("");
      setCustomLabel("");
      toast.success(`Added “${pad.label}” (key ${pads.length + 1})`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not import sound");
    } finally {
      setImporting(false);
    }
  };

  const handleUploadFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !canAddMore) return;
    setImporting(true);
    try {
      const pad = await importLocalSoundFile(file, customLabel);
      onAddPad(pad);
      setCustomLabel("");
      toast.success(`Added “${pad.label}” (key ${pads.length + 1})`);
    } catch {
      toast.error("Could not load that audio file.");
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
      {pads.map((pad, idx) => {
        const isActive = activePadIds.has(pad.id);
        return (
          <motion.button
            key={pad.id}
            type="button"
            whileTap={{ scale: 0.94 }}
            animate={isActive ? { scale: [1, 1.05, 1] } : { scale: 1 }}
            transition={{ duration: 0.2 }}
            onClick={() => onTriggerPad(pad)}
            title={`${pad.label} (Key ${idx + 1})`}
            className={cn(
              "flex h-6 max-w-28 shrink-0 items-center gap-1 rounded-md border px-1.5 text-[11px] font-medium transition-colors",
              isActive
                ? "border-brand bg-brand-soft text-brand"
                : "border-line bg-bg/70 text-fg hover:border-brand-line hover:bg-raised",
            )}
          >
            <kbd className="shrink-0 rounded bg-raised px-1 font-mono text-[9px] font-bold text-dim">
              {idx + 1}
            </kbd>
            <span className="truncate">{pad.label}</span>
          </motion.button>
        );
      })}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button
            size="icon-xs"
            variant="outline"
            aria-label="Manage soundboard"
            title="Soundboard (keys 1–9)"
            className="shrink-0"
          >
            <Plus className="size-3.5" />
          </Button>
        </DialogTrigger>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm">
              <Volume2 className="size-4 text-brand" />
              Soundboard ({pads.length}/{MAX_SOUND_PADS})
            </DialogTitle>
          </DialogHeader>

          <form onSubmit={(e) => void handleImportUrl(e)} className="space-y-2.5">
            <div className="space-y-1.5">
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="Paste MyInstants link (e.g. myinstants.com/en/instant/...)"
                disabled={importing || !canAddMore}
                className="text-sm"
              />
              <Input
                value={customLabel}
                onChange={(e) => setCustomLabel(e.target.value)}
                placeholder="Short label (optional)"
                disabled={importing || !canAddMore}
                className="text-sm"
              />
            </div>

            <div className="flex items-center gap-2">
              <Button
                type="submit"
                size="sm"
                disabled={!url.trim() || importing || !canAddMore}
                className="flex-1"
              >
                {importing ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Link2 className="size-3.5" />
                )}
                Import MyInstants
              </Button>

              <input
                ref={fileInputRef}
                type="file"
                accept="audio/*"
                className="hidden"
                onChange={(e) => void handleUploadFile(e)}
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={importing || !canAddMore}
                onClick={() => fileInputRef.current?.click()}
              >
                <Upload className="size-3.5" />
                File
              </Button>
            </div>
          </form>

          {pads.length > 0 && (
            <div className="max-h-56 space-y-1.5 overflow-y-auto pt-1">
              {pads.map((pad, idx) => (
                <div
                  key={pad.id}
                  className="flex items-center justify-between gap-2 rounded-lg border border-line bg-bg/60 px-2.5 py-1.5"
                >
                  <button
                    type="button"
                    onClick={() => onTriggerPad(pad)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    <kbd className="rounded border border-line bg-raised px-1.5 py-0.5 font-mono text-[10px] font-bold text-dim">
                      {idx + 1}
                    </kbd>
                    <span className="truncate text-xs font-medium text-fg">
                      {pad.label}
                    </span>
                  </button>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    onClick={() => onRemovePad(pad.id)}
                    aria-label={`Remove ${pad.label}`}
                    className="text-faint hover:text-down"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
});
