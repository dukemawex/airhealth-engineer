/**
 * Detect "use my location" style requests so the client can ask the device for a
 * fix BEFORE the message is sent (the model cannot read the browser's GPS).
 */
const EXPLICIT =
  /\b(?:use|access|get|grab|take|read|share|detect|find|pull|check)\b[^.?!\n]{0,24}\b(?:my|the)\s+(?:current\s+|device'?s?\s+|phone'?s?\s+|gps\s+|exact\s+|precise\s+|live\s+)*(?:location|position|gps|coordinates)\b|\b(?:my|the)\s+device'?s?\s+(?:location|position|gps)\b|\blocate me\b|\bvia my (?:device|phone|gps)\b/i;
const IMPLICIT = /\b(?:where i am|where i'm|around me|near me|my (?:current )?location|my area right now)\b/i;

/** "explicit": the user asked to use the device location. "implicit": the request is about where they are. */
export function locationIntent(text: string): "explicit" | "implicit" | null {
  if (EXPLICIT.test(text)) return "explicit";
  if (IMPLICIT.test(text)) return "implicit";
  return null;
}

/** Quick starts and messages that need a place before the agent can answer well. */
export function shouldLocateBeforeSend(text: string, locationOnFile: boolean): boolean {
  const intent = locationIntent(text);
  return intent === "explicit" || (intent === "implicit" && !locationOnFile);
}
