"use client";

/**
 * Browser-side media prep. Photos are downscaled to <= 1280 px JPEG and videos
 * contribute one representative frame, so uploads stay well under Vercel's
 * 4.5 MB request limit. Nothing is uploaded anywhere except /api/vision.
 */

export const MAX_EDGE = 1280;

export interface PreparedImage {
  dataUrl: string;
  width: number;
  height: number;
  kind: "photo" | "video_frame";
}

export function fitWithin(w: number, h: number, max = MAX_EDGE): { width: number; height: number } {
  if (w <= 0 || h <= 0) return { width: 0, height: 0 };
  const scale = Math.min(1, max / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

function draw(source: CanvasImageSource, w: number, h: number): PreparedImage["dataUrl"] {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is not available in this browser");
  ctx.drawImage(source, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", 0.85);
}

async function fromImage(file: File): Promise<PreparedImage> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" }).catch(() => null);
  if (bitmap) {
    const { width, height } = fitWithin(bitmap.width, bitmap.height);
    const dataUrl = draw(bitmap, width, height);
    bitmap.close();
    return { dataUrl, width, height, kind: "photo" };
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const { width, height } = fitWithin(img.naturalWidth, img.naturalHeight);
    return { dataUrl: draw(img, width, height), width, height, kind: "photo" };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function fromVideo(file: File): Promise<PreparedImage> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = url;
  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error("This video format can't be read by your browser"));
      setTimeout(() => reject(new Error("Timed out reading the video")), 15_000);
    });
    const t = Number.isFinite(video.duration) && video.duration > 0 ? Math.min(video.duration / 2, 3) : 0;
    await new Promise<void>((resolve, reject) => {
      video.onseeked = () => resolve();
      video.onerror = () => reject(new Error("Couldn't read a frame from the video"));
      video.currentTime = t;
      setTimeout(() => resolve(), 5_000);
    });
    const { width, height } = fitWithin(video.videoWidth, video.videoHeight);
    if (!width) throw new Error("Couldn't read a frame from the video");
    return { dataUrl: draw(video, width, height), width, height, kind: "video_frame" };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function prepareMedia(file: File): Promise<PreparedImage> {
  if (file.size > 200 * 1024 * 1024) throw new Error("That file is too large (max 200 MB).");
  if (file.type.startsWith("video/")) return fromVideo(file);
  if (file.type.startsWith("image/") || /\.(heic|heif|jpe?g|png|webp)$/i.test(file.name)) return fromImage(file);
  throw new Error("Please choose a photo or a short video.");
}
