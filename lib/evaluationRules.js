"use strict";

// Deterministic, server-side rules for evaluating interview answers.
// Nothing here calls Gemini and nothing here contains a question bank: every check is generic
// and works on any question/answer pair. Candidate answers are treated as untrusted input.

const FEEDBACK = {
  empty: "No answer was provided.",
  no_answer: "The response states that no answer is being given and contains no technical explanation.",
  gibberish: "The response appears to be random or meaningless text and contains no relevant technical explanation.",
  restates_question: "The response repeats the question without answering it and contains no relevant technical explanation.",
  meta_commentary: "The response does not address the technical question and contains no relevant technical explanation.",
  irrelevant: "The response does not address the technical question and contains no relevant technical explanation.",
  wrong_question:
    "The response does not answer this question. Its content addresses a different question, so no marks are awarded here.",
  placeholder: "The response is placeholder text and contains no relevant technical explanation.",
  prompt_injection:
    "The response tries to instruct the evaluator instead of answering. Those instructions were ignored and no relevant technical explanation remains."
};

// Answer types Gemini may return. Only "technical_answer" can earn marks.
const ANSWER_TYPES = [
  "technical_answer", "restates_question", "gibberish", "meta_commentary",
  "irrelevant", "no_answer", "prompt_injection"
];

const STOPWORDS = new Set((
  "a an the and or of to in on for with by at from as is are was were be been being it its this that these those " +
  "how what why when where which who whom would could should can will do does did you your i we our they their " +
  "me my us there here than then so if not no but about into over under using use used between"
).split(" "));

const normalizeText = t =>
  String(t).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

const stem = w => (w.length > 4 ? w.replace(/(ing|ed|es|s)$/, "") : w);

const contentTokens = text =>
  normalizeText(text).split(" ").filter(w => w && !STOPWORDS.has(w)).map(stem);

// ---------------------------------------------------------------------------
// Prompt-injection handling
// ---------------------------------------------------------------------------

const INJECTION_PATTERNS = [
  /\b(ignore|disregard|forget|override|bypass)\b[^.!?\n]{0,40}\b(previous|prior|above|earlier|all|any|your|the)\b[^.!?\n]{0,30}\b(instruction|instructions|prompt|prompts|rules?|guidelines?|directions?)\b/i,
  /\bnew\s+instructions?\b/i,
  /\b(system|developer)\s+(prompt|message|instructions?)\b/i,
  /\byou\s+are\s+now\b/i,
  /\b(pretend|act)\s+(to\s+be|as)\b/i,
  /\b(give|award|assign|grant|rate|score|mark)\b[^.!?\n]{0,25}\b(me\s+)?(full|maximum|max|perfect|top|highest|100|ten|10|\d{2,3})\b[^.!?\n]{0,20}\b(marks?|points?|score|percent|%|out of)\b/i,
  /\b(set|change|make)\s+(the\s+)?(score|marks?|grade)\s+(to|as|=)/i,
  /\bscore\s*[:=]\s*\d+/i,
  /\b(return|respond|output)\s+(only\s+)?(the\s+)?(json|following)\b/i,
  /\bi\s+deserve\s+(full|maximum|100|a\s+perfect)/i
];

// Phrases that talk to/about the evaluator or its grade rather than the technical question.
const META_PATTERNS = [
  /\b(your|the|this|that|my|previous)\s+(evaluation|assessment|grading|evaluator|grader|marking)\b/i,
  /\b(overall|final|low|high|total)\s+(score|marks|grade|rating)\b/i,
  /\bgibberish\b/i,
  /\b(the|this)\s+(ai|model|interviewer)\s+(is|was|should|has|gave)\b/i,
  /\b(is|was|seems|looks)\s+(reasonable|fair|unfair|correct|harsh)\b[^.!?\n]{0,40}\b(evaluation|score|grading|assessment)\b/i,
  /\bnot\s+poor\s+performance\b/i,
  /\b(across|for)\s+(all|the)\s+(five|ten|\d+)\s+(topics|questions|answers)\b/i
];

const splitSentences = text => String(text).split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(Boolean);

// Removes sentences that look like instructions aimed at the evaluator.
// What remains is the only text Gemini is shown, so injected instructions never reach the model.
function sanitizeAnswer(rawAnswer) {
  const raw = String(rawAnswer || "").replace(/\u0000/g, "").trim();
  const sentences = splitSentences(raw);
  let injectionDetected = false;
  const kept = [];
  for (const s of sentences) {
    if (INJECTION_PATTERNS.some(p => p.test(s))) {
      injectionDetected = true;
    } else {
      kept.push(s);
    }
  }
  return { text: kept.join(" ").trim(), injectionDetected };
}

// ---------------------------------------------------------------------------
// Heuristics
// ---------------------------------------------------------------------------

function looksLikeGibberish(text) {
  const nonSpace = text.replace(/\s/g, "");
  if (!nonSpace) return true;

  // Mostly symbols/punctuation (code answers still have plenty of letters/digits).
  const alnum = (nonSpace.match(/[\p{L}\p{N}]/gu) || []).length;
  if (alnum / nonSpace.length < 0.3) return true;

  // The vowel/consonant checks only make sense for Latin-script text.
  const words = (text.toLowerCase().match(/[a-z]+/g) || []);
  const latinChars = (nonSpace.match(/[a-z]/gi) || []).length;
  if (latinChars / nonSpace.length < 0.5) return false;
  if (words.length === 0) return true;

  const suspicious = words.filter(w => {
    if (w.length < 4) return false;
    if (/(.)\1{3,}/.test(w)) return true;                       // "aaaaa"
    if (/[^aeiouy]{6,}/.test(w)) return true;                   // "sdfghjkl"
    if (w.length >= 6 && !/[aeiouy]/.test(w)) return true;      // no vowels at all
    if (w.length >= 5 && /(asdf|qwer|zxcv|hjkl|sdfg|dfgh|wert|erty|rtyu|tyui|yuio|uiop|xcvb|cvbn|vbnm)/.test(w)) return true;
    return false;
  }).length;
  if (suspicious / words.length >= 0.5) return true;

  // The same token repeated over and over.
  if (words.length >= 4 && new Set(words).size / words.length <= 0.25) return true;

  return false;
}

function restatesQuestion(question, answer) {
  const q = new Set(contentTokens(question));
  const a = contentTokens(answer);
  if (!a.length) return false;
  const novel = a.filter(w => !q.has(w));
  const overlap = (a.length - novel.length) / a.length;
  // Almost every meaningful word comes from the question and almost nothing new is added.
  return overlap >= 0.75 && new Set(novel).size < 4;
}

function isMetaCommentary(answer) {
  const sentences = splitSentences(answer);
  if (!sentences.length) return false;
  const meta = sentences.filter(s => META_PATTERNS.some(p => p.test(s))).length;
  return meta / sentences.length >= 0.5;
}

const NO_ANSWER_RE = /^(idk|i\s*do(n'?t| not)\s*know|no\s*idea|not\s*sure|n\/?a|none|nothing|skip(ped)?|pass|\?+|-+|\.+)$/i;


const PLACEHOLDER_RE = /\blorem\s+ipsum\b|\bdolor\s+sit\s+amet\b|\bconsectetur\s+adipiscing\b/i;

// True when the answer fits ANOTHER question of the same interview clearly better than its own
// (for example the answers to two questions were pasted into the wrong boxes).
// Generic: compares content words only, no question bank.
function answersDifferentQuestion(question, answer, otherQuestions = []) {
  const a = new Set(contentTokens(answer));
  if (!a.size) return false;
  const share = q => {
    const qt = new Set(contentTokens(q));
    if (!qt.size) return { count: 0, ratio: 0 };
    let count = 0;
    qt.forEach(w => { if (a.has(w)) count++; });
    return { count, ratio: count / qt.size };
  };
  const own = share(question);
  return otherQuestions.some(q => {
    if (!q || normalizeText(q) === normalizeText(question)) return false;
    const other = share(q);
    return other.count >= 3 && other.ratio >= 0.2 && other.ratio >= 2 * own.ratio;
  });
}

// ---------------------------------------------------------------------------
// Pre-validation: runs BEFORE Gemini. Returns the text Gemini may see.
// ---------------------------------------------------------------------------

function prevalidateAnswer(question, rawAnswer, otherQuestions = []) {
  const { text, injectionDetected } = sanitizeAnswer(rawAnswer);
  const original = String(rawAnswer || "").trim();
  const invalid = reason => ({ valid: false, reason, feedback: FEEDBACK[reason], sanitized: "", injectionDetected });

  if (!original) return invalid("empty");
  if (!text) return invalid("prompt_injection");

  const trimmedForNoAnswer = text.replace(/[.!\s]+$/g, "").trim();
  if (NO_ANSWER_RE.test(trimmedForNoAnswer)) return invalid("no_answer");

  if (looksLikeGibberish(text)) return invalid("gibberish");

  const wordCount = text.split(/\s+/).filter(Boolean).length;
  if (wordCount < 3) return invalid(injectionDetected ? "prompt_injection" : "irrelevant");

  if (PLACEHOLDER_RE.test(text)) return invalid("placeholder");
  if (restatesQuestion(question, text)) return invalid("restates_question");
  if (isMetaCommentary(text)) return invalid("meta_commentary");
  if (answersDifferentQuestion(question, text, otherQuestions)) return invalid("wrong_question");

  return { valid: true, reason: null, feedback: null, sanitized: text, injectionDetected };
}

// ---------------------------------------------------------------------------
// Evidence checking (Gemini must quote the candidate to claim a point was covered)
// ---------------------------------------------------------------------------

function makeEvidenceChecker(answerText, questionText = "") {
  const normAnswer = normalizeText(answerText);
  const answerWords = new Set(normAnswer.split(" "));
  const questionWords = new Set(normalizeText(questionText).split(" "));
  return evidence => {
    const n = normalizeText(evidence);
    if (!n) return false;
    const words = n.split(" ");
    // Quoting the question's own words back is not evidence of knowledge.
    if (questionWords.size > 1 && words.filter(w => questionWords.has(w)).length / words.length >= 0.85) return false;
    if (normAnswer.includes(n)) return true;
    return words.filter(w => answerWords.has(w)).length / words.length >= 0.8;
  };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// coverage: 0-1 share of required points covered (explained = 1, mentioned = 0.25)
// explainedCount: number of points actually explained (not just named)
// accuracy: 0-100, depth: 0-3 (already capped by the caller)
function computeQuestionScore({ coverage, explainedCount, accuracy, depth }) {
  const cov = clamp(Number(coverage) || 0, 0, 1);
  const acc = clamp(Number(accuracy) || 0, 0, 100);
  const dep = clamp(Number(depth) || 0, 0, 3);

  // No required point addressed, or the grader itself says nothing relevant: zero marks.
  if (cov <= 0 || acc === 0 || dep === 0) return 0;

  // Accuracy and depth only count in proportion to how much of the question was actually addressed.
  const engagement = Math.min(1, cov / 0.25);
  let raw = 50 * cov + engagement * (0.2 * acc + (30 * dep) / 3);

  // An answer that only names terms without explaining any point cannot score above 20.
  if (!explainedCount) raw = Math.min(raw, 20);

  return clamp(Math.round(raw), 0, 100);
}

function computeOverallScore(scores) {
  if (!Array.isArray(scores) || !scores.length) return 0;
  const clean = scores.map(s => clamp(Math.round(Number(s) || 0), 0, 100));
  return Math.round(clean.reduce((a, b) => a + b, 0) / clean.length);
}

function correctnessLabel(score) {
  return score >= 70 ? "Correct" : score > 0 ? "Partially correct" : "Incorrect";
}

module.exports = {
  FEEDBACK,
  ANSWER_TYPES,
  normalizeText,
  sanitizeAnswer,
  prevalidateAnswer,
  makeEvidenceChecker,
  computeQuestionScore,
  computeOverallScore,
  correctnessLabel
};