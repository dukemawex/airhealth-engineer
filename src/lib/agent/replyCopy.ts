import { dedupeProfileAsks } from "./profileAsk";

/**
 * Deterministic copy clean-up for one assistant reply made of several text blocks
 * (Muse Spark writes a short preamble before each tool call, then the answer).
 * Pure and client-safe: the server cleans what it stores, the client cleans what
 * it renders while streaming, so both agree.
 */

const STOP = new Set(
  "a an the and or but so to of in on at for with by from is are was were be been am i i'm ill i'll me my we our you your it its it's this that these those there here let lets let's now just will can could would should do does did have has had then first quickly also again right away up out as if about into over".split(" "),
);

function words(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^a-z0-9.' ]+/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^'+|'+$/g, "").replace(/\.+$/, ""))
    .filter(Boolean);
}

function contentSet(s: string): Set<string> {
  return new Set(
    words(s)
      .filter((w) => !STOP.has(w))
      .map((w) => (w.length > 4 ? w.replace(/(ing|ed|es|s)$/, "") : w)),
  );
}

const norm = (s: string) => words(s).join(" ");

/** Overlap coefficient of content words; 1 for identical normalized text. */
export function sentenceSimilarity(a: string, b: string): number {
  if (norm(a) && norm(a) === norm(b)) return 1;
  const A = contentSet(a);
  const B = contentSet(b);
  const min = Math.min(A.size, B.size);
  if (min < 3) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / min;
}

const STRUCTURED = /^\s*(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|\||>|```)/;
const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;

/**
 * Drop repeated preamble sentences: a plain-prose sentence that is (near) identical
 * to one already written earlier in the same reply. Headings, bullets and tables are
 * left alone. Short blocks (preambles) use a looser threshold than the final answer.
 */
export function dedupePreambles(blocks: string[]): string[] {
  const seen: string[] = [];
  return blocks.map((block) => {
    const short = wordCount(block) <= 40;
    const threshold = short ? 0.6 : 0.8;
    const out = block.split("\n").map((line) => {
      if (!line.trim() || STRUCTURED.test(line)) return line;
      const parts = line.split(/(?<=[.?!…])\s+/);
      const kept = parts.filter((p) => {
        const t = p.trim();
        if (!t) return false;
        const dup = seen.some((s) => sentenceSimilarity(s, t) >= threshold);
        seen.push(t);
        return !dup;
      });
      if (kept.length === parts.length) return line;
      return kept.join(" ").trim() || null;
    });
    return out
      .filter((l): l is string => l !== null)
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  });
}

const QUESTION_START =
  /^(?:(?:is|are|was|were)\s+(?:there|it|this|that|anyone|someone|your|you|the)\b|(?:do|does|did|have|has)\s+(?:you|anyone|someone|your|they|we)\b|(?:can|could|would|will|should|may|shall)\s+(?:you|i|we|anyone|someone|your)\b|which\s+\w+|what\s+(?:is|are|do|does|time|city|town|area|kind|type|sort|sensitivit\w*|condition\w*)\b|how\s+(?:long|many|much|often|old|far|soon|do|does|are|is)\b|any(?:one)?\s+(?:sensitivit\w*|condition\w*|symptom\w*|other|one|preference\w*|device\w*|health|with|who|at home|in your)\b|anyone\b)/i;

/** Make interrogative sentences end with "?" ("Which city are you in." -> "Which city are you in?"). */
export function fixQuestionMarks(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      if (/^\s*(?:\||```|#{1,6}\s)/.test(line)) return line;
      const lead = /^(\s*(?:[-*+]|\d+[.)])?\s*)/.exec(line)?.[1] ?? "";
      const body = line.slice(lead.length);
      const parts = body.split(/(?<=[.?!])\s+/);
      const fixed = parts.map((p) => {
        const m = /^([*_]*)(.*?)([*_]*)([.]?)([*_]*)$/.exec(p);
        if (!m) return p;
        const [, pre, core, mid, dot, end] = m;
        const post = `${mid}${end}`;
        if (!core || /[?!:]$/.test(core) || wordCount(core) > 30) return p;
        if (!QUESTION_START.test(core.trim())) return p;
        if (!dot && p !== parts.at(-1)) return p;
        return `${pre}${core}?${post}`;
      });
      return lead + fixed.join(" ");
    })
    .join("\n");
}

/** Full clean-up used by the server (stored text) and the client (rendered text). */
export function cleanReplyBlocks(blocks: string[], opts: { alreadyAsked?: boolean } = {}): string[] {
  return dedupePreambles(dedupeProfileAsks(blocks, opts)).map(fixQuestionMarks);
}
