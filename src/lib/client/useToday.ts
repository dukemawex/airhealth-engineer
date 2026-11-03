"use client";

import { useSyncExternalStore } from "react";

const fmt = () =>
  new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date());

function subscribe(onChange: () => void) {
  const t = setInterval(onChange, 60_000);
  return () => clearInterval(t);
}

/** Today's date in the reader's locale; empty during server render (the page is static). */
export function useToday(): string {
  return useSyncExternalStore(subscribe, fmt, () => "");
}
