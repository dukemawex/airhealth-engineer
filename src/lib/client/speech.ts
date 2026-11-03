"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

/**
 * Voice in and out, entirely in the browser:
 * - Dictation via the Web Speech API (SpeechRecognition; Chrome, Edge, Safari). Where it is missing
 *   (e.g. Firefox) the mic button is hidden and typing works as before.
 * - Spoken replies via speechSynthesis, off by default, remembered per device.
 * This is the fallback engine; see voice.ts for Muse Voice Transcribe (preferred).
 */

/* -------------------------------- Recognition -------------------------------- */

interface RecognitionAlternative {
  transcript: string;
}
interface RecognitionResult {
  isFinal: boolean;
  0: RecognitionAlternative;
}
interface RecognitionEvent {
  resultIndex: number;
  results: { length: number; [i: number]: RecognitionResult };
}
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: RecognitionEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}
type RecognitionCtor = new () => Recognition;

function recognitionCtor(): RecognitionCtor | undefined {
  if (typeof window === "undefined") return undefined;
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

const noopSubscribe = () => () => undefined;

const RECOGNITION_ERRORS: Record<string, string> = {
  "not-allowed": "Microphone access is blocked. Allow it in the site settings next to the address bar.",
  "service-not-allowed": "Speech recognition isn't allowed in this browser profile.",
  "audio-capture": "No microphone was found.",
  network: "The browser's speech service couldn't be reached. Check your connection or type instead.",
  "no-speech": "Didn't catch anything. Tap the mic and try again.",
  "language-not-supported": "Speech recognition doesn't support your browser language.",
};

export function useDictation(onFinal: (text: string) => void) {
  const supported = useSyncExternalStore(noopSubscribe, () => Boolean(recognitionCtor()), () => false);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<Recognition | null>(null);
  const finalRef = useRef(onFinal);
  useEffect(() => {
    finalRef.current = onFinal;
  }, [onFinal]);
  useEffect(() => () => rec.current?.abort(), []);

  const start = () => {
    const Ctor = recognitionCtor();
    if (!Ctor || rec.current) return;
    stopSpeaking();
    const r = new Ctor();
    r.lang = navigator.language || "en-US";
    r.continuous = false;
    r.interimResults = true;
    r.maxAlternatives = 1;
    r.onresult = (e) => {
      let live = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i]!;
        if (res.isFinal) finalRef.current(res[0].transcript.trim());
        else live += res[0].transcript;
      }
      setInterim(live);
    };
    r.onerror = (e) => {
      if (e.error !== "aborted") setError(RECOGNITION_ERRORS[e.error] ?? `Voice input stopped (${e.error}).`);
    };
    r.onend = () => {
      rec.current = null;
      setListening(false);
      setInterim("");
    };
    setError(null);
    setInterim("");
    try {
      r.start();
      rec.current = r;
      setListening(true);
    } catch {
      setError("Voice input couldn't start. Try again.");
    }
  };
  const stop = () => rec.current?.stop();
  return { supported, listening, interim, error, start, stop, clearError: () => setError(null) };
}

/* -------------------------------- Synthesis -------------------------------- */

const SPEAK_KEY = "airhealth.speakReplies";
const SPEAK_EVENT = "airhealth:speak-pref";

export const ttsSupported = () => typeof window !== "undefined" && "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;

export function getSpeakPreference(): boolean {
  return typeof window !== "undefined" && window.localStorage.getItem(SPEAK_KEY) === "1";
}
export function setSpeakPreference(on: boolean) {
  window.localStorage.setItem(SPEAK_KEY, on ? "1" : "0");
  if (!on) stopSpeaking();
  window.dispatchEvent(new Event(SPEAK_EVENT));
}
function subscribeSpeak(cb: () => void) {
  window.addEventListener(SPEAK_EVENT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(SPEAK_EVENT, cb);
    window.removeEventListener("storage", cb);
  };
}
export function useSpeakPreference() {
  const on = useSyncExternalStore(subscribeSpeak, getSpeakPreference, () => false);
  const supported = useSyncExternalStore(noopSubscribe, ttsSupported, () => false);
  return { on, supported, set: setSpeakPreference };
}

/** Markdown to plain speech: drop code, links' URLs, tables and symbols that read badly. */
export function toSpeakable(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s*\|.*\|\s*$/gm, " ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/[*_~>#]+/g, "")
    .replace(/µg\/m³|μg\/m³/g, " micrograms per cubic metre")
    .replace(/PM2\.5/g, "PM 2.5")
    .replace(/\s+/g, " ")
    .trim();
}

/** Split into sentence chunks under ~220 chars (Chrome cuts long utterances off). */
export function speechChunks(text: string, max = 220): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [text];
  const out: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if ((cur + s).length > max && cur) {
      out.push(cur.trim());
      cur = "";
    }
    if (s.length > max) {
      for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max).trim());
    } else cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}

export function stopSpeaking() {
  if (ttsSupported()) window.speechSynthesis.cancel();
}

export function speak(markdown: string) {
  if (!ttsSupported()) return;
  const text = toSpeakable(markdown);
  if (!text) return;
  const synth = window.speechSynthesis;
  synth.cancel();
  const lang = navigator.language || "en-US";
  const voice = synth.getVoices().find((v) => v.lang === lang) ?? synth.getVoices().find((v) => v.lang.startsWith(lang.slice(0, 2)));
  for (const chunk of speechChunks(text)) {
    const u = new SpeechSynthesisUtterance(chunk);
    u.lang = lang;
    if (voice) u.voice = voice;
    u.rate = 1;
    synth.speak(u);
  }
}
