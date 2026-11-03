"use client";

import { useSyncExternalStore } from "react";

/** Judge mode: shows live telemetry (reasoning timeline, raw model output, endpoint status). Off by default. */
const KEY = "airhealth.judge";
const EVENT = "airhealth:judge";

function read(): boolean {
  if (typeof window === "undefined") return false;
  const q = new URLSearchParams(window.location.search).get("judge");
  if (q === "1" || q === "0") window.localStorage.setItem(KEY, q);
  return window.localStorage.getItem(KEY) === "1";
}
function subscribe(cb: () => void) {
  window.addEventListener(EVENT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener("storage", cb);
  };
}
export function setJudgeMode(on: boolean) {
  window.localStorage.setItem(KEY, on ? "1" : "0");
  window.dispatchEvent(new Event(EVENT));
}
export function useJudgeMode() {
  const on = useSyncExternalStore(subscribe, read, () => false);
  return { on, set: setJudgeMode, toggle: () => setJudgeMode(!on) };
}
