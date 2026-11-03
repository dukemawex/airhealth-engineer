import { z } from "zod";

/** What the "air today" card shows. Built client-side from the live snapshot only. */
export const ShareInputSchema = z.object({
  place: z.string().trim().min(1).max(120),
  pm25: z.number().min(0).max(2000).nullable(),
  aqi: z.number().int().min(0).max(999).nullable(),
  category: z.string().max(60).nullable(),
  measured: z.boolean(),
  action: z.string().trim().max(140).optional(),
});
export type ShareInput = z.infer<typeof ShareInputSchema>;

const MOOD: Record<string, string> = {
  good: "crisp clear air, luminous deep-teal sky, soft clean light, sharp distant horizon",
  moderate: "light veil of haze, warm teal-to-amber gradient, softened horizon",
  unhealthy_for_sensitive_groups: "visible amber haze layer, diffused low sun, muted skyline silhouettes",
  unhealthy: "thick orange-brown haze, low contrast, glowing particulate light shafts",
  very_unhealthy: "heavy smog, dim red-brown sun disc, dense suspended particles",
  hazardous: "near-opaque dark smog, ember-red light, almost no visibility",
};

/** Muse Image prompt for the background art. No text: the app overlays exact numbers itself. */
export function sharePrompt(input: ShareInput): string {
  const mood = MOOD[input.category ?? ""] ?? MOOD.moderate!;
  return [
    `Cinematic abstract atmospheric artwork of the sky over ${input.place}, evoking today's outdoor air quality: ${mood}.`,
    "Inside, a calm bright room seen through a window, clean air glowing in soft teal (#14b8a6) with a subtle airflow of fine light particles being filtered.",
    "Vertical 4:5 composition, dark lower third left empty for overlay text, high-end editorial poster look, gentle film grain.",
    "Absolutely no text, no letters, no numbers, no logos, no people, no faces.",
  ].join(" ");
}

export function categoryLabel(cat: string | null): string {
  if (!cat) return "No PM2.5 reading";
  return cat.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

/** Text lines drawn on the card, deterministic from live data. */
export function cardLines(input: ShareInput, now = new Date()) {
  return {
    kicker: `Air today · ${now.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`,
    place: input.place,
    big: input.aqi !== null ? String(input.aqi) : "—",
    bigLabel: "US AQI (from PM2.5)",
    pm: input.pm25 !== null ? `PM2.5 ${input.pm25.toFixed(1)} µg/m³ · ${input.measured ? "measured (OpenAQ)" : "modelled (CAMS)"}` : "No PM2.5 reading",
    category: categoryLabel(input.category),
    action: input.action ?? "My indoor air is being engineered: filtration on, windows timed to the forecast.",
    footer: "AirHealth Engineer · indoor-air control, not medical advice",
  };
}

/** Plain-text message for WhatsApp, deterministic from the live snapshot. */
export function whatsappText(input: ShareInput, origin?: string): string {
  const parts = [
    `Air today in ${input.place}:`,
    input.aqi !== null ? `US AQI ${input.aqi}` : "no AQI reading",
    input.pm25 !== null ? `(PM2.5 ${input.pm25.toFixed(1)} µg/m³, ${input.measured ? "measured, OpenAQ" : "modelled, CAMS"})` : "",
    input.category ? `· ${categoryLabel(input.category)}.` : "",
  ].filter(Boolean);
  const lines = [parts.join(" "), input.action ?? "I'm engineering my indoor air: filtration on, windows timed to the forecast."];
  lines.push(`Checked with AirHealth Engineer${origin ? `: ${origin}` : ""} (air and device control, not medical advice).`);
  return lines.join("\n");
}

/** wa.me link that opens WhatsApp with the text pre-filled; the user picks the chat and presses send. */
export function whatsappUrl(text: string): string {
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}
