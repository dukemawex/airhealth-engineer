import { beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "@/lib/logger";
import { fetchAirQuality, rankStations } from "@/lib/services/airQuality";
import {
  clearGeocodeCache,
  looksLikePostcodeOrAddress,
  NOMINATIM_USER_AGENT,
  pickBestPlace,
  resolveLocation,
  type GeocodeDeps,
} from "@/lib/services/geocode";
import { clearNewsCache, decodeEntities, getNewsDigest, parseRss } from "@/lib/services/news";
import { formatPlace, shortPlace } from "@/lib/place";
import { speechChunks, toSpeakable } from "@/lib/client/speech";
import { encodeCommand, sfloat16 } from "@/lib/client/bluetooth";

const logger = createLogger({ test: true });
type Handler = (url: URL, init?: RequestInit) => unknown | Response;
function fakeFetch(handler: Handler) {
  const calls: Array<{ url: URL; headers: Record<string, string> }> = [];
  const impl = async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    const out = handler(url, init);
    if (out instanceof Response) return out;
    return new Response(typeof out === "string" ? out : JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { impl, calls };
}
const deps = (fetchImpl: GeocodeDeps["fetchImpl"]): GeocodeDeps => ({
  baseUrl: "https://geo.test/v1",
  nominatimBaseUrl: "https://nominatim.test",
  timezoneBaseUrl: "https://tz.test/v1",
  fetchImpl,
  logger,
  timeoutMs: 2000,
});

describe("location resolution", () => {
  beforeEach(() => clearGeocodeCache());

  it("names shared coordinates via reverse geocoding and looks up the timezone", async () => {
    const f = fakeFetch((url) => {
      if (url.pathname === "/reverse")
        return { address: { suburb: "Ikeja", city: "Lagos", state: "Lagos State", country: "Nigeria", country_code: "ng" } };
      if (url.pathname === "/v1/forecast") return { timezone: "Africa/Lagos" };
      return new Response("nope", { status: 404 });
    });
    const loc = await resolveLocation({ latitude: 6.6018123, longitude: 3.3515456, accuracyMeters: 30 }, deps(f.impl));
    expect(loc).toMatchObject({ source: "user_coordinates", area: "Ikeja", name: "Lagos", country: "Nigeria", countryCode: "NG", timezone: "Africa/Lagos", accuracyMeters: 30 });
    expect(loc.latitude).toBe(6.60181);
    expect(formatPlace(loc)).toBe("Ikeja, Lagos, Lagos State, Nigeria");
    expect(shortPlace(loc)).toBe("Lagos, Nigeria");
    const rev = f.calls.find((c) => c.url.pathname === "/reverse")!;
    expect(rev.headers["user-agent"]).toBe(NOMINATIM_USER_AGENT);
    // Second call for (almost) the same spot is cached.
    await resolveLocation({ latitude: 6.60182, longitude: 3.35155 }, deps(f.impl));
    expect(f.calls.filter((c) => c.url.pathname === "/reverse")).toHaveLength(1);
  });

  it("still returns the coordinates when reverse geocoding fails", async () => {
    const f = fakeFetch(() => new Response("down", { status: 503 }));
    const loc = await resolveLocation({ latitude: 51.5, longitude: -0.12 }, deps(f.impl));
    expect(loc).toMatchObject({ latitude: 51.5, longitude: -0.12, source: "user_coordinates" });
    expect(formatPlace(loc)).toMatch(/51\.5/);
  });

  it("routes postcodes to Nominatim first", async () => {
    expect(looksLikePostcodeOrAddress("SW1A 1AA")).toBe(true);
    expect(looksLikePostcodeOrAddress("São Paulo")).toBe(false);
    const f = fakeFetch((url) => {
      if (url.pathname === "/search")
        return [{ lat: "51.501", lon: "-0.1416", name: "SW1A 1AA", display_name: "SW1A 1AA, London", address: { postcode: "SW1A 1AA", city: "London", country: "United Kingdom", country_code: "gb" } }];
      if (url.pathname === "/v1/forecast") return { timezone: "Europe/London" };
      return { results: [] };
    });
    const loc = await resolveLocation({ city: "SW1A 1AA" }, deps(f.impl));
    expect(loc).toMatchObject({ resolvedBy: "nominatim", countryCode: "GB", timezone: "Europe/London", query: "SW1A 1AA" });
    expect(f.calls[0]!.url.hostname).toBe("nominatim.test");
  });

  it("falls back to Nominatim when Open-Meteo has no match, and errors helpfully when nothing matches", async () => {
    const f = fakeFetch((url) => (url.hostname === "geo.test" ? { results: [] } : url.pathname === "/search" ? [] : {}));
    await expect(resolveLocation({ city: "Nowhereville" }, deps(f.impl))).rejects.toMatchObject({ code: "not_found" });
    expect(f.calls.some((c) => c.url.hostname === "nominatim.test")).toBe(true);
  });

  it("prefers the populous place and honours typed qualifiers", () => {
    const hits = [
      { name: "Lagos", latitude: 43, longitude: 1, country: "France", country_code: "FR", population: 300 },
      { name: "Lagos", latitude: 6.45, longitude: 3.39, country: "Nigeria", country_code: "NG", population: 15_000_000 },
      { name: "Lagos", latitude: 37.1, longitude: -8.67, country: "Portugal", country_code: "PT", population: 31_000 },
    ];
    expect(pickBestPlace(hits, {})!.country).toBe("Nigeria");
    expect(pickBestPlace(hits, { qualifiers: ["Portugal"] })!.country).toBe("Portugal");
    expect(pickBestPlace(hits, { countryCode: "fr" })!.country).toBe("France");
  });
});

describe("station search", () => {
  const station = (id: number, lat: number, lon: number, ageDays: number) => ({
    id,
    name: `S${id}`,
    coordinates: { latitude: lat, longitude: lon },
    sensors: [{ id: id * 10, parameter: { name: "pm25", units: "µg/m³", displayName: "PM2.5" } }],
    datetimeLast: { utc: new Date(Date.now() - ageDays * 86_400_000).toISOString() },
  });

  it("ranks recent stations first, then by real distance, within the radius", () => {
    const here = { latitude: 6.5, longitude: 3.4 };
    const ranked = rankStations(here, [station(1, 6.52, 3.4, 30), station(2, 6.6, 3.4, 0), station(3, 6.51, 3.4, 1), station(4, 9, 3.4, 0)] as never, 25);
    expect(ranked.map((s) => s.id)).toEqual([3, 2, 1]);
    expect(ranked[0]!.distanceKm).toBeCloseTo(1.11, 1);
  });

  it("widens to a 100 km box when nothing reports within 25 km", async () => {
    const f = fakeFetch((url) => {
      if (url.pathname === "/v3/locations") {
        if (url.searchParams.get("bbox")) return { results: [station(7, 8.95, 4.55, 0)] }; // ~55 km away
        return { results: [] };
      }
      if (url.pathname === "/v3/locations/7/latest") return { results: [{ datetime: { utc: new Date().toISOString() }, value: 41, sensorsId: 70, locationsId: 7 }] };
      return new Response("nope", { status: 404 });
    });
    const snap = await fetchAirQuality({ latitude: 8.5, longitude: 4.55, name: "Ilorin", source: "geocoded" } as never, 15000, {
      fetchImpl: f.impl,
      logger,
      timeoutMs: 2000,
      openaqApiKey: "k",
      openaqBaseUrl: "https://openaq.test/v3",
      modelFallback: false,
      modelBaseUrl: "https://model.test",
    });
    expect(snap.searchRadiusKm).toBe(100);
    expect(snap.nearestStationKm).toBeGreaterThan(45);
    expect(snap.sourceNote).toMatch(/km/);
    const loc = f.calls.filter((c) => c.url.pathname === "/v3/locations");
    expect(loc.map((c) => c.url.searchParams.get("radius"))).toEqual(["15000", "25000", null]);
    expect(loc.every((c) => !(c.url.searchParams.get("bbox") && c.url.searchParams.get("coordinates")))).toBe(true);
  });
});

const rss = (items: string) => `<?xml version="1.0"?><rss><channel><title>Feed</title>${items}</channel></rss>`;
const item = (title: string, link: string, date: string, source = "") =>
  `<item><title><![CDATA[${title}]]></title><link>${link}</link><pubDate>${date}</pubDate>${source ? `<source url="https://x.test">${source}</source>` : ""}</item>`;

describe("news", () => {
  beforeEach(() => clearNewsCache());

  it("parses RSS, decodes entities, strips the ' - Source' suffix and drops invalid items", () => {
    expect(decodeEntities("Smog &amp; haze &#8217;s &#x41;")).toBe("Smog & haze ’s A");
    const items = parseRss(
      rss(
        item("Lagos smog worsens - The Guardian Nigeria", "https://news.test/a", "Mon, 02 Nov 2026 10:00:00 GMT", "The Guardian Nigeria") +
          item("No link", "javascript:alert(1)", "Mon, 02 Nov 2026 10:00:00 GMT") +
          item("Bad date", "https://news.test/b", "not a date"),
      ),
      "Fallback",
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ title: "Lagos smog worsens", source: "The Guardian Nigeria", url: "https://news.test/a" });
  });

  it("builds topical sections from real feeds only and degrades honestly", async () => {
    const now = new Date("2026-11-03T08:00:00Z");
    const recent = "Mon, 02 Nov 2026 10:00:00 GMT";
    const f = fakeFetch((url) => {
      if (url.hostname === "gn.test") {
        const q = url.searchParams.get("q") ?? "";
        if (q.includes("site:")) return new Response("down", { status: 503 });
        return rss(
          item("Harmattan haze pushes PM2.5 up - Punch", "https://n.test/1?" + encodeURIComponent(q), recent, "Punch") +
            item("Webinar: clean air and children's lungs - WHO", "https://n.test/2?" + encodeURIComponent(q), recent, "WHO") +
            item("Football results - Sports", "https://n.test/3", recent, "Sports"),
        );
      }
      return new Response("down", { status: 503 });
    });
    const digest = await getNewsDigest("Lagos", { fetchImpl: f.impl, logger, googleNewsBaseUrl: "https://gn.test/rss/search", metaFeeds: ["https://meta.test/feed"], now: () => now });
    const by = Object.fromEntries(digest.sections.map((s) => [s.id, s]));
    expect(by.local!.items.map((i) => i.title)).toContain("Harmattan haze pushes PM2.5 up");
    expect(by.local!.items.some((i) => i.title.startsWith("Football"))).toBe(false);
    expect(by.talks!.items.every((i) => /webinar|talk|podcast/i.test(i.title))).toBe(true);
    expect(by.meta!.items).toHaveLength(0);
    expect(by.meta!.note).toBeTruthy();
  });
});

describe("voice helpers", () => {
  it("turns markdown into speakable text", () => {
    expect(toSpeakable("## Plan\n- **Close** windows\n- PM2.5 is 40 µg/m³ [source](https://x)\n```js\nx\n```")).toBe(
      "Plan Close windows PM 2.5 is 40 micrograms per cubic metre source",
    );
  });
  it("chunks long text at sentence boundaries", () => {
    const text = "One sentence here. ".repeat(30);
    const chunks = speechChunks(text, 60);
    expect(chunks.every((c) => c.length <= 60)).toBe(true);
    expect(chunks.join(" ").replace(/\s+/g, " ")).toBe(text.trim());
  });
});

describe("bluetooth encoding", () => {
  it("decodes IEEE-11073 SFLOAT and splits commands into 20-byte packets", () => {
    expect(sfloat16(0x0072)).toBe(114);
    expect(sfloat16(0xf072)).toBeCloseTo(11.4);
    expect(sfloat16(0x07ff)).toBeNull();
    const packets = encodeCommand("apr_1", { action: "set_purifier", mode: "high" } as never);
    expect(packets.every((p) => p.length <= 20)).toBe(true);
    const line = new TextDecoder().decode(Uint8Array.from(packets.flatMap((p) => [...p])));
    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line)).toEqual({ type: "airhealth.command", approvalId: "apr_1", command: { action: "set_purifier", mode: "high" } });
  });
});
