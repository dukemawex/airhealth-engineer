"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { TARGET_SAMPLE_RATE, downmix, encodeWav, resampleLinear } from "@/lib/audio/wav";
import { authHeaders } from "./api";
import { stopSpeaking, useDictation } from "./speech";

/**
 * Voice input with Muse Voice Transcribe first and the browser's Web Speech API as
 * the fallback:
 * - "muse": MediaRecorder captures push-to-talk audio, it is decoded, downmixed and
 *   resampled to 16 kHz mono PCM16 WAV in the browser, and POSTed to /api/transcribe.
 * - "browser": SpeechRecognition (Chrome, Edge, Safari), used when the deployment
 *   reports Muse Voice Transcribe unavailable, the browser can't record, or a Muse
 *   request fails (then it sticks for this page load).
 */
export type VoiceEngine = "muse" | "browser";
export type VoiceState = "idle" | "recording" | "transcribing";

const MAX_RECORDING_MS = 45_000;
const noopSubscribe = () => () => undefined;

function canRecord(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as { AudioContext?: unknown; webkitAudioContext?: unknown };
  return Boolean(typeof navigator.mediaDevices?.getUserMedia === "function" && typeof MediaRecorder !== "undefined" && (w.AudioContext || w.webkitAudioContext));
}

let capsPromise: Promise<boolean> | null = null;
function museTranscribeLive(): Promise<boolean> {
  capsPromise ??= fetch("/api/capabilities", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((c: { features?: { transcribe?: boolean } } | null) => Boolean(c?.features?.transcribe))
    .catch(() => false);
  return capsPromise;
}

async function blobToWav(blob: Blob): Promise<Uint8Array> {
  const Ctor = (window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)!;
  const ctx = new Ctor();
  try {
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    const chans = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i));
    return encodeWav(resampleLinear(downmix(chans), buf.sampleRate, TARGET_SAMPLE_RATE));
  } finally {
    void ctx.close();
  }
}

export function useVoiceInput(onFinal: (text: string) => void) {
  const browser = useDictation(onFinal);
  const recordable = useSyncExternalStore(noopSubscribe, canRecord, () => false);
  const [museLive, setMuseLive] = useState<boolean | null>(null);
  const [museFailed, setMuseFailed] = useState(false);
  const [state, setState] = useState<VoiceState>("idle");
  const [error, setError] = useState<string | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finalRef = useRef(onFinal);
  useEffect(() => {
    finalRef.current = onFinal;
  }, [onFinal]);

  useEffect(() => {
    let alive = true;
    if (recordable) void museTranscribeLive().then((ok) => alive && setMuseLive(ok));
    return () => {
      alive = false;
    };
  }, [recordable]);

  const release = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);
  useEffect(
    () => () => {
      if (recRef.current?.state === "recording") recRef.current.stop();
      release();
    },
    [release],
  );

  const engine: VoiceEngine = recordable && museLive && !museFailed ? "muse" : "browser";
  const supported = engine === "muse" || browser.supported;

  const transcribe = async (blob: Blob) => {
    setState("transcribing");
    try {
      const wav = await blobToWav(blob);
      if (wav.length < 44 + TARGET_SAMPLE_RATE * 2 * 0.3) {
        setError("That was too short. Hold on a moment longer and try again.");
        return;
      }
      const res = await fetch("/api/transcribe", {
        method: "POST",
        headers: { "content-type": "audio/wav", ...authHeaders() },
        body: wav as BlobPart,
      });
      const data = (await res.json().catch(() => ({}))) as { transcript?: string; error?: { message?: string } };
      if (!res.ok) throw new Error(data.error?.message ?? `Transcription failed (${res.status})`);
      const text = (data.transcript ?? "").trim();
      if (text) finalRef.current(text);
      else setError("Muse didn't catch any words. Try again a little closer to the mic.");
    } catch (e) {
      setMuseFailed(true);
      setError(
        `Muse Voice Transcribe didn't respond (${e instanceof Error ? e.message : "error"}).` +
          (browser.supported ? " Switched to your browser's dictation; tap the mic again." : " Please type instead."),
      );
    } finally {
      setState("idle");
    }
  };

  const start = async () => {
    if (engine === "browser") return browser.start();
    if (recRef.current) return;
    stopSpeaking();
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      streamRef.current = stream;
      const rec = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.onstop = () => {
        recRef.current = null;
        release();
        void transcribe(new Blob(chunks, { type: rec.mimeType || "audio/webm" }));
      };
      rec.start();
      recRef.current = rec;
      setState("recording");
      timerRef.current = setTimeout(() => rec.state === "recording" && rec.stop(), MAX_RECORDING_MS);
    } catch (e) {
      release();
      const denied = e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "SecurityError");
      setError(denied ? "Microphone access is blocked. Allow it in the site settings next to the address bar." : "No microphone was found.");
    }
  };
  const stop = () => {
    if (engine === "browser") return browser.stop();
    if (recRef.current?.state === "recording") recRef.current.stop();
  };

  const listening = engine === "browser" ? browser.listening : state === "recording";
  return {
    engine,
    supported,
    listening,
    transcribing: state === "transcribing",
    interim: engine === "browser" ? browser.interim : state === "recording" ? "Recording for Muse Voice Transcribe… tap the mic to finish" : state === "transcribing" ? "Muse is transcribing…" : "",
    error: error ?? browser.error,
    start: () => void start(),
    stop,
    clearError: () => {
      setError(null);
      browser.clearError();
    },
  };
}
