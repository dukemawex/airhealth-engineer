import { describe, expect, it } from "vitest";
import { whatsappText, whatsappUrl } from "@/lib/share/card";

describe("WhatsApp share", () => {
  const input = { place: "Awterere, Kwara", pm25: 40.04, aqi: 112, category: "unhealthy_for_sensitive_groups", measured: false };

  it("builds a plain message from the live numbers, labelled modelled or measured", () => {
    const t = whatsappText(input, "https://airhealth-engineer.vercel.app");
    expect(t).toContain("Air today in Awterere, Kwara: US AQI 112 (PM2.5 40.0 µg/m³, modelled, CAMS) · Unhealthy for sensitive groups.");
    expect(t).toContain("https://airhealth-engineer.vercel.app");
    expect(t).toMatch(/not medical advice/);
    expect(whatsappText({ ...input, measured: true })).toContain("measured, OpenAQ");
    expect(whatsappText({ ...input, pm25: null, aqi: null, category: null })).toContain("no AQI reading");
  });

  it("encodes a wa.me link with no recipient, so the user picks the chat", () => {
    const url = whatsappUrl("Air & smoke: 40 µg/m³\nline 2");
    expect(url.startsWith("https://wa.me/?text=")).toBe(true);
    expect(decodeURIComponent(url.split("text=")[1]!)).toBe("Air & smoke: 40 µg/m³\nline 2");
    expect(url).not.toMatch(/wa\.me\/\d/);
  });
});
