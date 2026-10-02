/**
 * Pronunciation-tolerant entity capture.
 *
 * Callers spell names out loud ("K-S-T-E-S-T", "Sudhanshu" / "Sudhansu",
 * "thirteen" / "teen", "nine two seven eight zero") and STT mangles them.
 * Everything captured here is (a) decoded from spell-out form, (b) reduced to a
 * phonetic key, and (c) resolved to ONE canonical spelling before it is written
 * to the database — so two spellings of the same person never become two rows.
 */

const LETTER_ALIASES: Record<string, string> = {
  ah: "a", a: "a", ay: "a", ei: "a", aye: "a",
  bee: "b", be: "b", b: "b",
  cee: "c", see: "c", c: "c",
  dee: "d", d: "d",
  ee: "e", e: "e",
  ef: "f", eff: "f", f: "f",
  jee: "g", ge: "g", gee: "g", g: "g",
  aitch: "h", h: "h",
  eye: "i", ai: "i", i: "i",
  jay: "j", j: "j",
  kay: "k", cay: "k", k: "k",
  el: "l", ell: "l", l: "l",
  em: "m", m: "m",
  en: "n", n: "n",
  oh: "o", o: "o",
  pee: "p", p: "p",
  cue: "q", queue: "q", q: "q",
  ar: "r", are: "r", r: "r",
  ess: "s", es: "s", s: "s",
  tee: "t", t: "t",
  u: "u", you: "u", ewe: "u",
  vee: "v", v: "v",
  doubleyou: "w", dublyu: "w", w: "w",
  ex: "x", ecks: "x", x: "x",
  why: "y", wye: "y", y: "y",
  zee: "z", z: "z",
  zed: "z",
};

const DIGIT_WORDS: Record<string, string> = {
  zero: "0", oh: "0", one: "1", won: "1", two: "2", to: "2", too: "2",
  three: "3", tree: "3", four: "4", for: "4", fore: "4", five: "5", fife: "5",
  six: "6", seven: "7", eight: "8", ate: "8", nine: "9", niner: "9",
  first: "1", second: "2", third: "3", fourth: "4", fifth: "5", sixth: "6",
  seventh: "7", eighth: "8", ninth: "9", tenth: "10",
};

const NUMBER_WORDS = [
  "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen",
  "eighteen", "nineteen",
];

const TENS_WORDS: Record<string, number> = {
  ten: 10, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

const UNDER_TWENTY: Record<string, number> = {
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};

const JOINERS = new Set(["and", "for", "with", "the", "a", "an"]);

export const cleanName = (raw: string): string =>
  raw
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

export const titleCase = (raw: string): string =>
  cleanName(raw)
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

/** Tokenise on anything that is not a letter/digit so spell-outs split cleanly. */
const tokenize = (text: string): string[] => text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);

const LETTER_TOKEN = /^[a-z]$/;
const UPPER_LETTER = /^[A-Z]$/;

const repeatAliases: Record<string, string> = { u: "w", e: "f", l: "l", o: "o", s: "s", z: "z", m: "m", n: "n", r: "r" };

const letterFromToken = (token: string, next?: string): { letter: string; consumed: number } | null => {
  const t = token.toLowerCase();
  if (LETTER_TOKEN.test(t)) return { letter: t, consumed: 1 };
  if (t === "double" || t === "triple") {
    if (next && LETTER_TOKEN.test(next.toLowerCase())) {
      const letter = next.toLowerCase();
      const doubled = t === "double" ? (repeatAliases[letter] ?? letter.repeat(2)) : letter.repeat(3);
      return { letter: doubled, consumed: 2 };
    }
    return null;
  }
  const alias = LETTER_ALIASES[t];
  if (alias && alias.length === 1) return { letter: alias, consumed: 1 };
  return null;
};

export interface SpellOutRun {
  letters: string;
  /** Word-normalised text with the run replaced by the decoded name. */
  replaced: string;
  length: number;
  /** True when every letter was written as an explicit single character. */
  strict: boolean;
}

/**
 * Find a spelled-out name anywhere in an utterance.
 * "yeah, it's gonna be K-S-T-E-S-T" -> "Kstest" (run found mid-sentence).
 *
 * Common English words that are also letter names ("be", "see", "tea") only count
 * inside a spelled-out run when they are written as bare single capitals or as a
 * separated run, so "it'll be fine" is never read as "It'llbf".
 */
export function findSpellOutRun(text: string): SpellOutRun | null {
  const best: Array<SpellOutRun & { priority: number }> = [];

  // (a) Explicit separated run: "K-S-T-E-S-T", "k. s. t.", "K S T E S T".
  // Either every letter is capitalised, or the run uses spelling separators
  // (dash/dot) — otherwise ordinary lowercase words ("it'll be fine") match.
  const separated = text.match(/[\p{Lu}](?:[\s\-.,'’]+[\p{Lu}]){2,}|\p{Ll}(?:[\-.'']+\p{Ll}){2,}/gu);
  for (const raw of separated ?? []) {
    // "J-O-H-N D-O-E" is two names: keep the dash/dot groups separate.
    const chunks = /[-.]/.test(raw)
      ? raw.split(/[\s]+/).filter(Boolean)
      : [raw];
    for (const chunk of chunks) {
      const tokens = chunk.split(/[\s\-.,'’]+/).filter(Boolean);
      if (tokens.length < 2 || tokens.length > 14) continue;
      if (!tokens.every((t) => /^\p{L}$/u.test(t))) continue;
      const letters = tokens.map((t) => t.toLowerCase()).join("");
      best.push({
        letters: titleCase(letters),
        replaced: letters,
        length: tokens.length,
        strict: true,
        // Explicit "J-O-H-N" beats a looser run that swallowed the next name too.
        priority: 2,
      });
      break;
    }
  }

  // (b)/(c) Whitespace run inside the sentence, scored by strictness + length
  const tokens = tokenize(text);
  for (let i = 0; i < tokens.length; i++) {
    const first = letterFromToken(tokens[i] ?? "", tokens[i + 1]);
    if (!first) continue;
    const second = letterFromToken(tokens[i + 1] ?? "", tokens[i + 2]);
    if (!second) continue;
    let letters = `${first.letter}${second.letter}`;
    let consumed = 2;
    let strictChars = [tokens[i] ?? "", tokens[i + 1] ?? ""].filter((t) => UPPER_LETTER.test(t)).length;
    let j = i + 2;
    while (j < tokens.length) {
      const next = letterFromToken(tokens[j] ?? "", tokens[j + 1]);
      if (!next) break;
      letters += next.letter;
      strictChars += UPPER_LETTER.test(tokens[j] ?? "") ? 1 : 0;
      consumed += next.consumed;
      j += next.consumed;
    }
    const allSingle = consumed >= 2 && (tokens[i] ?? "").length === 1;
    const strictRun = allSingle && consumed >= 3;
    if (!strictRun && strictChars < 3) continue;
    best.push({
      letters: titleCase(letters),
      replaced: `${tokens.slice(0, i).join(" ")} ${letters} ${tokens.slice(j).join(" ")}`.replace(/\s+/g, " ").trim(),
      length: consumed + strictChars / 10,
      strict: strictRun,
      priority: strictRun ? 1 : 0,
    });
  }

  if (!best.length) return null;
  best.sort((a, b) => {
    if (a.strict !== b.strict) return a.strict ? -1 : 1;
    if (a.priority !== b.priority) return b.priority - a.priority;
    return b.length - a.length;
  });
  const top = best[0];
  return top ? { letters: top.letters, replaced: top.replaced, length: top.length, strict: top.strict } : null;
}

/** "K-S-T-E-S-T" / "k. s. t. e. s. t." / "K S T E S T" -> "Kstest" */
export function decodeSpellOut(raw: string): string | null {
  const run = findSpellOutRun(raw);
  return run ? run.letters : null;
}

/** "nine two seven eight zero" -> "92780"; "oh eighteen ninety" -> "01890". */
export function digitsFromSpoken(raw: string): string | null {
  const tokens = raw
    .toLowerCase()
    .replace(/\b(\d)\s+(\d)\b/g, "$1$2")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  let out = "";
  let digitBuf = "";
  const flush = () => {
    if (digitBuf) out += digitBuf;
    digitBuf = "";
  };
  for (const [i, t] of tokens.entries()) {
    if (/^\d+$/.test(t)) {
      flush();
      out += t;
      continue;
    }
    if (DIGIT_WORDS[t]) {
      const d = DIGIT_WORDS[t];
      if (d.length > 1) {
        flush();
        out += d;
      } else {
        digitBuf += d;
      }
      continue;
    }
    if (TENS_WORDS[t] != null) {
      // Spoken years: "nineteen ninety" -> 1990, "twenty twenty five" -> 2025
      const prev = tokens[i - 1] ?? "";
      const joined = UNDER_TWENTY[prev];
      if (joined != null && joined < 20 && TENS_WORDS[t] % 10 === 0) {
        out = out.slice(0, -(String(joined).length)) + String(joined * 100 + TENS_WORDS[t]);
        continue;
      }
      flush();
      out += t;
      continue;
    }
    if (UNDER_TWENTY[t] != null) {
      flush();
      out += t;
      continue;
    }
    if (JOINERS.has(t)) continue;
    flush();
  }
  flush();
  const cleaned = out.replace(/\D/g, "");
  if (cleaned.length >= 2) return cleaned;
  return null;
}

const metaphoneish = (word: string): string => {
  let w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return "";
  if (w.length <= 3) return w;
  w = w
    .replace(/^(kn|gn|pn|ae|wr)/, (m) => m.slice(1))
    .replace(/^x/, "s")
    .replace(/ph/g, "f")
    .replace(/sh|ch/g, "x")
    .replace(/th/g, "0")
    .replace(/wh/g, "w")
    .replace(/ck/g, "k")
    .replace(/sch/g, "sk")
    .replace(/ee|ea|ie|ei/g, "y")
    .replace(/oo|ou|au|aw/u, "u")
    .replace(/ai|ay|ei/g, "a")
    .replace(/[cqgy]/g, "k")
    .replace(/z/g, "s")
    .replace(/v/g, "f")
    .replace(/[aeiou]/g, "");
  if (w.length > 4) w = w.slice(0, 4);
  return w;
};

/** "Sudhanshu" -> "s0ns" ; homophone-stable across spelling variants. */
export function phoneticKey(name: string): string {
  const parts = cleanName(name).split(" ").filter((p) => p.length > 0 && !JOINERS.has(p));
  const keys = parts.map((p) => (p.length <= 2 ? p : metaphoneish(p))).filter(Boolean);
  return keys.join("-");
}

const levenshtein = (a: string, b: string): number => {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length] ?? Math.abs(a.length - b.length);
};

const similarity = (a: string, b: string): number => {
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  return 1 - levenshtein(a, b) / max;
};

export type CanonicalMatch = {
  canonical: string;
  confidence: number;
  matched: boolean;
  via: "exact" | "phonetic" | "fuzzy" | "none";
  alternatives: string[];
};

export interface CanonicalOptions {
  /** Existing spellings (e.g. customers already in the DB). */
  known?: string[];
  /** Ask the model when phonetic/fuzzy matching is ambiguous (slower, ~200ms). */
  llm?: (candidates: string[]) => Promise<string | null>;
  /** Reject matches weaker than this (0..1). */
  minConfidence?: number;
}

/**
 * Resolve any spoken/spelled variant to ONE canonical spelling.
 * Exact -> phonetic key -> edit distance -> (optional) LLM tie-break.
 */
export async function resolveCanonicalName(
  spoken: string,
  opts: CanonicalOptions = {},
): Promise<CanonicalMatch> {
  const min = opts.minConfidence ?? 0.86;
  const typed = cleanName(spoken);
  if (!typed) return { canonical: "", confidence: 0, matched: false, via: "none", alternatives: [] };

  // Known spellings may be full names; match against each part so a first-name
  // slot resolves against "Sudhanshu Sharma" -> "Sudhanshu".
  const known = (opts.known ?? [])
    .map(cleanName)
    .filter(Boolean)
    .flatMap((entry) => (entry.includes(" ") ? entry.split(" ") : [entry]));

  if (known.includes(typed)) {
    return { canonical: titleCase(typed), confidence: 1, matched: true, via: "exact", alternatives: [] };
  }
  if (!known.length) {
    return { canonical: titleCase(typed), confidence: 0.6, matched: false, via: "none", alternatives: [] };
  }

  const key = phoneticKey(typed);
  const samePhonetic = known.filter((k) => phoneticKey(k) === key);
  const onlyPhonetic = samePhonetic[0];
  if (samePhonetic.length === 1 && onlyPhonetic) {
    return { canonical: titleCase(onlyPhonetic), confidence: 0.97, matched: true, via: "phonetic", alternatives: [] };
  }
  if (samePhonetic.length > 1) {
    if (opts.llm) {
      const picked = await opts.llm(samePhonetic.map(titleCase));
      if (picked) {
        const hit = samePhonetic.find((c) => cleanName(picked) === c || similarity(cleanName(picked), c) > 0.8);
        if (hit) return { canonical: titleCase(hit), confidence: 0.93, matched: true, via: "phonetic", alternatives: [] };
      }
    }
    return { canonical: titleCase(typed), confidence: 0.7, matched: false, via: "none", alternatives: samePhonetic.map(titleCase) };
  }

  const scored = known
    .map((k) => ({ k, s: Math.max(similarity(typed, k), similarity(key, phoneticKey(k)) * 0.99) }))
    .sort((a, b) => b.s - a.s);
  const best = scored[0];
  const runnerUp = scored[1];
  if (best && best.s >= min && (!runnerUp || best.s - runnerUp.s > 0.04)) {
    return { canonical: titleCase(best.k), confidence: Math.min(0.95, best.s), matched: true, via: "fuzzy", alternatives: [] };
  }
  return {
    canonical: titleCase(typed),
    confidence: best ? best.s : 0,
    matched: false,
    via: "none",
    alternatives: scored.filter((s) => s.s > 0.6).slice(0, 3).map((s) => titleCase(s.k)),
  };
}

/** Is the utterance a spelled-out string ("K S T E S T", "double-u double-l")? */
export function looksSpelledOut(text: string): boolean {
  return decodeSpellOut(text) !== null;
}

/** Word-boundary safe "is this the no/cancel answer" detector. */
export function isNegative(text: string): boolean {
  return /(^|\b)(no|nope|nah|not right|incorrect|wrong|that's wrong|that's not right|no thanks|none|nope that|not correct|bad|uh no|actually no)\b/i.test(text);
}

export function isAffirmative(text: string): boolean {
  return /(^|\b)(yes|yeah|yep|yup|sure|correct|right|that's right|that's correct|ok|okay|perfect|exactly|do it|go ahead|sounds good|please do|confirm(ed)?)\b/i.test(text);
}
