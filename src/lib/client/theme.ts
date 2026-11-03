"use client";

import { useCallback, useSyncExternalStore } from "react";

export type Theme = "dark" | "light";
const KEY = "airhealth.theme";

const read = (): Theme => (document.documentElement.dataset.theme === "light" ? "light" : "dark");

function subscribe(onChange: () => void) {
  const obs = new MutationObserver(onChange);
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => obs.disconnect();
}

/** Dark studio is the default; light is opt-in and remembered on this device. */
export function useTheme() {
  const theme = useSyncExternalStore<Theme>(subscribe, read, () => "dark");
  const toggle = useCallback(() => {
    const next: Theme = read() === "dark" ? "light" : "dark";
    if (next === "light") document.documentElement.dataset.theme = "light";
    else delete document.documentElement.dataset.theme;
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* storage unavailable: theme still applies for this page */
    }
  }, []);
  return { theme, toggle };
}
