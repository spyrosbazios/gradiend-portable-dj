import { useEffect, useRef } from "react";
import { useRegisterSW } from "virtual:pwa-register/react";
import { toast } from "sonner";

const UPDATE_TOAST_ID = "pwa-update-toast";

export function PwaUpdater() {
  const regRef = useRef<ServiceWorkerRegistration | null>(null);
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_swUrl, registration) {
      if (!registration) return;
      regRef.current = registration;
      window.setInterval(() => {
        void registration.update().then(() => {
          if (registration.waiting) setNeedRefresh(true);
        });
      }, 60 * 60 * 1000);
    },
  });

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible" && regRef.current) {
        void regRef.current.update().then(() => {
          if (regRef.current?.waiting) setNeedRefresh(true);
        });
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [setNeedRefresh]);

  useEffect(() => {
    if (!needRefresh) return;
    toast("A new version of Portable DJ is ready", {
      id: UPDATE_TOAST_ID,
      duration: Infinity,
      action: {
        label: "Reload",
        onClick: (e) => {
          e.preventDefault();
          toast("Reloading…", { id: UPDATE_TOAST_ID, duration: Infinity });
          navigator.serviceWorker?.addEventListener(
            "controllerchange",
            () => window.location.reload(),
            { once: true },
          );
          void updateServiceWorker(true);
          window.setTimeout(() => {
            toast.error("Update did not complete. Please refresh manually.", {
              id: UPDATE_TOAST_ID,
            });
          }, 4000);
        },
      },
      cancel: {
        label: "Later",
        onClick: () => setNeedRefresh(false),
      },
    });
  }, [needRefresh, setNeedRefresh, updateServiceWorker]);

  return null;
}
