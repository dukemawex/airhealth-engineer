import { fetchWithTimeout, type FetchLike } from "../http";
import type { Logger } from "../logger";

/**
 * "News & talks": recent air-quality / health headlines from free, keyless RSS feeds.
 *
 * - Google News RSS search (https://news.google.com/rss/search?q=...) for local, worldwide and talks.
 * - Meta's own feeds (about.fb.com newsroom, engineering.fb.com) plus a site-restricted Google News
 *   search of ai.meta.com / about.fb.com, filtered to health, science and environment topics.
 *
 * Every item comes from a feed fetched server-side; nothing is generated or invented. Items without a
 * title, an http(s) link and a parseable date are dropped. Sections that fail or have nothing relevant
 * come back empty with a reason, so the UI can say so honestly.
 */

export interface NewsItem {
  title: string;
  url: string;
  source: string;
  sourceUrl?: string;
  publishedAt: string;
}

export type NewsSectionId = "local" | "global" | "talks" | "meta";

export interface NewsSection {
  id: NewsSectionId;
  title: string;
  items: NewsItem[];
  /** Why the section is empty (feed down, nothing relevant), when it is. */
  note?: string;
  feeds: string[];
}

export interface NewsDigest {
  place?: string;
  fetchedAt: string;
  sections: NewsSection[];
}

export interface NewsDeps {
  fetchImpl: FetchLike;
  logger: Logger;
  timeoutMs?: number;
  googleNewsBaseUrl?: string;
  metaFeeds?: string[];
  now?: () => Date;
}

const GOOGLE_NEWS = "https://news.google.com/rss/search";
const META_FEEDS = ["https://about.fb.com/news/feed/", "https://engineering.fb.com/feed/"];
const PER_SECTION = 6;
const CACHE_TTL_MS = 30 * 60 * 1000;
const UA = "AirHealthEngineer/1.0 (+https://github.com/dukemawex/airhealth-engineer)";

/* ------------------------------- RSS parsing -------------------------------- */

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function tag(xml: string, name: string): { text?: string; attrs?: string } {
  const m = xml.match(new RegExp(`<${name}(\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  if (!m) return {};
  let text = m[2]!.trim();
  const cdata = text.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  text = cdata ? cdata[1]!.trim() : decodeEntities(text);
  return { text: text.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim(), attrs: m[1] };
}

/** Parse RSS 2.0 `<item>`s. Tolerant of CDATA and entities; drops anything incomplete. */
export function parseRss(xml: string, fallbackSource: string): NewsItem[] {
  const items: NewsItem[] = [];
  for (const m of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const body = m[1]!;
    let title = tag(body, "title").text;
    const link = tag(body, "link").text;
    const date = tag(body, "pubDate").text ?? tag(body, "dc:date").text;
    const src = tag(body, "source");
    if (!title || !link || !date) continue;
    if (!/^https?:\/\//i.test(link)) continue;
    const ms = Date.parse(date);
    if (!Number.isFinite(ms)) continue;
    let source = src.text || fallbackSource;
    // Google News titles end with " - Publisher".
    if (src.text && title.endsWith(` - ${src.text}`)) title = title.slice(0, -(src.text.length + 3)).trim();
    else if (!src.text) {
      const dash = title.lastIndexOf(" - ");
      if (dash > 20 && fallbackSource === "Google News") {
        source = title.slice(dash + 3).trim();
        title = title.slice(0, dash).trim();
      }
    }
    const sourceUrl = src.attrs?.match(/url="([^"]+)"/)?.[1];
    items.push({ title, url: link, source, sourceUrl: sourceUrl ? decodeEntities(sourceUrl) : undefined, publishedAt: new Date(ms).toISOString() });
  }
  return items;
}

/* --------------------------------- Fetching --------------------------------- */

const feedCache = new Map<string, { at: number; items: NewsItem[] }>();
export function clearNewsCache() {
  feedCache.clear();
}

async function fetchFeed(url: string, fallbackSource: string, deps: NewsDeps): Promise<NewsItem[]> {
  const hit = feedCache.get(url);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.items;
  const once = async () => {
    const res = await fetchWithTimeout(
      deps.fetchImpl,
      url,
      { headers: { "User-Agent": UA, Accept: "application/rss+xml, application/xml;q=0.9, */*;q=0.5" } },
      deps.timeoutMs ?? 6_000,
    );
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    return parseRss(await res.text(), fallbackSource);
  };
  try {
    // One quick retry: feed hosts occasionally stall on a single request.
    const items = await once().catch(() => once());
    feedCache.set(url, { at: Date.now(), items });
    if (feedCache.size > 200) feedCache.delete(feedCache.keys().next().value!);
    return items;
  } catch (err) {
    if (hit) return hit.items; // stale but real beats nothing
    throw err;
  }
}

export function googleNewsUrl(query: string, base = GOOGLE_NEWS): string {
  const u = new URL(base);
  u.searchParams.set("q", query);
  u.searchParams.set("hl", "en-US");
  u.searchParams.set("gl", "US");
  u.searchParams.set("ceid", "US:en");
  return u.toString();
}

const TOPIC = /air[- ]quality|air pollution|pollut|smog|haze|particulate|pm2\.?5|wildfire|smoke|emission|climate|environment|sustainab|health|medical|asthma|respirat|lung|scien/i;
/** Title must actually be about air (Google News matches body text too, which lets heat or Diwali stories through). */
export const AIR_TOPIC = /\bair\b|pollut|smog|haze|harmattan|dust|smoke|wildfire|\baqi\b|pm ?2\.?5|pm10|particulate|emission|ozone|asthma|breath|lung|respirat/i;
const TALK = /webinar|\btalks?\b|podcast|lecture|conference|symposium|episode|interview|workshop|seminar|report launch|keynote/i;
/** Drop social posts and evergreen "AQI for <town>" directory pages, which are not news. */
const notSocial = (i: NewsItem) =>
  !/^(facebook|instagram|x|twitter|tiktok|youtube)$/i.test(i.source) &&
  !/^air quality in |air quality index \(aqi\)|air quality (&|and) pollen|air quality forecast$/i.test(i.title);

const META_HOST = /(^|\.)(meta\.com|fb\.com|facebook\.com|metademolab\.com)$/i;

function dedupe(items: NewsItem[]): NewsItem[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    const k = i.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const newest = (a: NewsItem, b: NewsItem) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt);

function hostOf(u?: string) {
  try {
    return u ? new URL(u).hostname : "";
  } catch {
    return "";
  }
}

async function section(
  id: NewsSectionId,
  title: string,
  feeds: Array<{ url: string; source: string }>,
  deps: NewsDeps,
  opts: { maxAgeDays: number; filter?: (i: NewsItem) => boolean; emptyNote: string },
): Promise<NewsSection> {
  const now = (deps.now?.() ?? new Date()).getTime();
  const results = await Promise.allSettled(feeds.map((f) => fetchFeed(f.url, f.source, deps)));
  const failed = results.filter((r) => r.status === "rejected");
  for (const r of failed) deps.logger.warn("news feed failed", { section: id, error: (r as PromiseRejectedResult).reason });
  const items = dedupe(
    results
      .flatMap((r) => (r.status === "fulfilled" ? r.value : []))
      .filter((i) => now - Date.parse(i.publishedAt) <= opts.maxAgeDays * 86_400_000 && Date.parse(i.publishedAt) <= now + 3_600_000)
      .filter(opts.filter ?? (() => true))
      .sort(newest),
  ).slice(0, PER_SECTION);
  const note =
    items.length > 0
      ? undefined
      : failed.length === feeds.length
        ? "The news feeds could not be reached just now. Try again later."
        : opts.emptyNote;
  return { id, title, items, note, feeds: feeds.map((f) => f.url) };
}

export async function getNewsDigest(place: string | undefined, deps: NewsDeps): Promise<NewsDigest> {
  const base = deps.googleNewsBaseUrl ?? GOOGLE_NEWS;
  const gn = (q: string) => ({ url: googleNewsUrl(q, base), source: "Google News" });
  const cleanPlace = place?.replace(/["()]/g, "").trim().slice(0, 80) || undefined;
  const metaFeeds = (deps.metaFeeds ?? META_FEEDS).map((url) => ({ url, source: hostOf(url).includes("engineering") ? "Engineering at Meta" : "Meta Newsroom" }));

  const sections = await Promise.all([
    cleanPlace
      ? section("local", `Near ${cleanPlace}`, [gn(`("air quality" OR "air pollution" OR smog OR haze) "${cleanPlace}" when:30d`)], deps, {
          maxAgeDays: 45,
          filter: (i) => AIR_TOPIC.test(i.title) && notSocial(i),
          emptyNote: `No air-quality stories mentioning ${cleanPlace} in the last 30 days.`,
        })
      : Promise.resolve<NewsSection>({ id: "local", title: "Near you", items: [], note: "Set a location to see local stories.", feeds: [] }),
    section("global", "Worldwide", [gn(`("air pollution" OR "air quality") health when:7d`)], deps, {
      maxAgeDays: 14,
      filter: (i) => AIR_TOPIC.test(i.title) && notSocial(i),
      emptyNote: "No worldwide air-quality health stories this week.",
    }),
    section("talks", "Talks, webinars & podcasts", [gn(`("air quality" OR "air pollution") (webinar OR talk OR podcast OR lecture OR conference OR seminar) when:60d`)], deps, {
      maxAgeDays: 60,
      filter: (i) => AIR_TOPIC.test(i.title) && TALK.test(i.title) && notSocial(i),
      emptyNote: "No recent talks or webinars found.",
    }),
    section(
      "meta",
      "From Meta: AI for health, science & environment",
      [...metaFeeds, gn(`(site:ai.meta.com OR site:about.fb.com OR site:engineering.fb.com) (health OR "air quality" OR climate OR environment OR science)`)],
      deps,
      {
        maxAgeDays: 365,
        // Only Meta's own publications, and only on-topic ones (most Meta posts are about products).
        filter: (i) =>
          (i.source !== "Google News" || META_HOST.test(hostOf(i.sourceUrl)) || /meta|facebook/i.test(i.source)) &&
          (i.source.startsWith("Meta") || i.source.startsWith("Engineering at Meta") || META_HOST.test(hostOf(i.sourceUrl)) || /^(AI at Meta|Meta AI|Facebook)$/i.test(i.source)) &&
          TOPIC.test(i.title),
        emptyNote: "Meta hasn't published anything on air quality or health recently. Nothing is shown rather than unrelated posts.",
      },
    ),
  ]);
  return { place: cleanPlace, fetchedAt: new Date().toISOString(), sections };
}
