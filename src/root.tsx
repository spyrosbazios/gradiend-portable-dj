import { useEffect } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { MotionConfig } from "framer-motion";
import { ThemeProvider } from "@/hooks/use-theme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { PwaUpdater } from "@/components/pwa-updater";
import { queryClient, router } from "@/router";

export function Root() {
  useEffect(() => {
    const dismissSplash = () => {
      const el = document.getElementById("splash");
      if (!el || el.dataset.done === "1") return;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          el.dataset.done = "1";
          window.setTimeout(() => el.remove(), 350);
        });
      });
    };

    const unsub = router.subscribe("onRendered", dismissSplash);
    const fallbackTimer = window.setTimeout(dismissSplash, 3000);
    dismissSplash();

    return () => {
      unsub();
      window.clearTimeout(fallbackTimer);
    };
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <MotionConfig reducedMotion="user">
          <TooltipProvider delayDuration={300}>
            <RouterProvider router={router} />
            <Toaster position="bottom-right" />
            <PwaUpdater />
          </TooltipProvider>
        </MotionConfig>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
