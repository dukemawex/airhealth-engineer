/**
 * Keep the sensitivity-profile question to at most one per reply, and none when
 * the previous reply already asked. Muse Spark may write text in several steps of
 * one run (before and after tool calls), and each step tends to end with the
 * same question; this dedupes it deterministically. Pure and client-safe: the
 * server cleans what it stores, and the client cleans what it renders while
 * streaming.
 */

const PROFILE_TERMS =
  /\b(sensitivity profile|sensitivit(?:y|ies)|sensitive (?:to|people|members?|groups?)|anyone (?:at home|in (?:the|your) (?:home|house(?:hold)?))|household members?|age group|asthma|copd|allerg(?:y|ies)|heart condition|health conditions?)\b/i;
const ASK_CUE =
  /\?|\b(?:share|tell me|let me know|reply with|add (?:your|a|any)|could you|can you|would you|do you|does anyone|is anyone|are there|is there|any(?:one)? (?:with|who)|if you(?:'d| would)? (?:like|want)|optional(?:ly)?:)\b/i;

/** True when a sentence asks the user for their sensitivity profile. */
export function isProfileAsk(sentence: string): boolean {
  const s = sentence.trim();
  if (!s || !PROFILE_TERMS.test(s) || !ASK_CUE.test(s)) return false;
  // Statements about a profile already on file are not questions.
  if (/\b(?:recorded|on file|saved|noted|using your|based on your|you (?:said|shared|mentioned))\b/i.test(s) && !/\?/.test(s)) return false;
  return true;
}

/** True when any sentence in the text asks for the profile. */
export function asksForProfile(text: string | null | undefined): boolean {
  return Boolean(text) && splitSentences(text!).some(isProfileAsk);
}

function splitSentences(text: string): string[] {
  return text.split(/(?<=[.?!])\s+|\n+/);
}

const HEADING = /^\s{0,3}#{1,6}\s/;
const BULLET_ONLY = /^\s*(?:[-*+]|\d+[.)])\s*$/;

/**
 * Remove profile asks from one text block. `keepFirst` keeps the first ask found.
 * Returns the cleaned text and whether an ask is (still) present in it.
 */
function cleanBlock(text: string, keepFirst: boolean): { text: string; kept: boolean } {
  let kept = false;
  const lines = text.split("\n").map((line) => {
    if (!PROFILE_TERMS.test(line)) return line;
    const m = /^(\s*(?:[-*+]|\d+[.)]|>)?\s*)(.*)$/.exec(line);
    const prefix = m?.[1] ?? "";
    const parts = (m?.[2] ?? line).split(/(?<=[.?!])\s+/);
    const out = parts.filter((p) => {
      if (!isProfileAsk(p)) return true;
      if (keepFirst && !kept) {
        kept = true;
        return true;
      }
      return false;
    });
    if (out.length === parts.length) return line;
    const rest = out.join(" ").trim();
    return rest ? `${prefix}${rest}` : null;
  });
  const kept1 = lines.filter((l): l is string => l !== null && !BULLET_ONLY.test(l));
  // Drop headings left with nothing under them (e.g. "### One question").
  const out: string[] = [];
  kept1.forEach((line, i) => {
    if (HEADING.test(line)) {
      const next = kept1.slice(i + 1).find((l) => l.trim());
      if (next === undefined || HEADING.test(next)) return;
    }
    out.push(line);
  });
  return {
    text: out.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
    kept,
  };
}

/**
 * Dedupe across the text blocks of one reply (in order). The LAST ask is the one
 * kept, because the final answer is where the question belongs; earlier
 * step-level asks are removed. With `alreadyAsked` (the previous reply asked and
 * the user did not answer), every ask is removed.
 */
export function dedupeProfileAsks(blocks: string[], opts: { alreadyAsked?: boolean } = {}): string[] {
  if (opts.alreadyAsked) return blocks.map((b) => (asksForProfile(b) ? cleanBlock(b, false).text : b));
  let lastAsk = -1;
  blocks.forEach((b, i) => {
    if (asksForProfile(b)) lastAsk = i;
  });
  return blocks.map((b, i) => {
    if (i < lastAsk && asksForProfile(b)) return cleanBlock(b, false).text;
    if (i === lastAsk) return cleanBlock(b, true).text;
    return b;
  });
}

/**
 * Whether the reply before the latest user message already asked for the profile.
 * `messages` is the chat history in order; only role and text matter.
 */
export function previousReplyAsked(
  messages: ReadonlyArray<{ role: string; text: string | null | undefined }>,
  hasProfile: boolean,
): boolean {
  if (hasProfile) return false;
  let i = messages.length - 1;
  while (i >= 0 && messages[i]?.role !== "user") i--;
  // Walk back through the previous reply (all assistant blocks until the user turn before it).
  for (let j = i - 1; j >= 0; j--) {
    const m = messages[j];
    if (!m || m.role === "user") break;
    if (m.role === "assistant" && asksForProfile(m.text)) return true;
  }
  return false;
}
