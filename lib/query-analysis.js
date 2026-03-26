import { tokenize } from "./text-utils.js";

const MONTHS = {
  january: "01",
  february: "02",
  march: "03",
  april: "04",
  may: "05",
  june: "06",
  july: "07",
  august: "08",
  september: "09",
  october: "10",
  november: "11",
  december: "12",
};

const QUERY_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "around",
  "be",
  "by",
  "can",
  "daily",
  "date",
  "did",
  "do",
  "does",
  "during",
  "first",
  "for",
  "from",
  "how",
  "in",
  "is",
  "it",
  "many",
  "mention",
  "mentioned",
  "month",
  "notes",
  "of",
  "on",
  "or",
  "over",
  "show",
  "summary",
  "tell",
  "the",
  "their",
  "theme",
  "themes",
  "time",
  "to",
  "was",
  "what",
  "when",
  "where",
  "which",
  "who",
  "with",
  "year"
]);

function inferMode(query) {
  const lower = query.toLowerCase();

  if (/\bfirst mention|first mentioned|first time\b/.test(lower)) {
    return "first_mention";
  }

  if (/\brecurring|repeated|appear again|themes?\b/.test(lower)) {
    return "recurring_themes";
  }

  if (/\bevolution|over time|timeline|how .* changed|progression\b/.test(lower)) {
    return "evolution_over_time";
  }

  if (/\bcompare|comparison|versus|vs\b/.test(lower)) {
    return "comparison";
  }

  if (/\bin .* notes\b|\bsummarize .* month\b|\bsummary\b/.test(lower)) {
    return "temporal_summary";
  }

  if (
    /\bwhen\b/.test(lower) &&
    /\b(date|month|day|notes?)\b/.test(lower)
  ) {
    return "scoped_lookup";
  }

  if (/\bwho|what|where|which|how many|does|is|are|can\b/.test(lower)) {
    return "fact_lookup";
  }

  return "unsupported / unknown";
}

function extractMonthYear(query) {
  const lower = query.toLowerCase();

  const monthMatch = lower.match(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})\b/
  );

  if (monthMatch) {
    const [, monthName, year] = monthMatch;
    return `${year}-${MONTHS[monthName]}`;
  }

  const numeric = lower.match(/\b(\d{4})[-/](\d{2})\b/);
  if (numeric) {
    return `${numeric[1]}-${numeric[2]}`;
  }

  return null;
}

function extractExplicitDate(query) {
  const lower = query.toLowerCase();
  const match = lower.match(/\b(\d{4})[-_/]?(\d{2})[-_/]?(\d{2})\b/);
  if (!match) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function inferDocTypePreference(query) {
  const lower = query.toLowerCase();
  if (/\bdaily notes?\b|\bdaily\b/.test(lower)) return "daily note";
  if (/\bcompany\b|\bpolicy\b|\bonboarding\b|\bbilling\b|\bauth\b|\bsupport\b/.test(lower)) {
    return "company doc";
  }
  if (/\binterview\b|\bprep\b|\bnda\b|\bcv\b/.test(lower)) {
    return "prep/interview note";
  }
  if (/\bapp\b|\bproduct\b|\bfeature\b|\brepo\b|\bdesign\b/.test(lower)) {
    return "app/product note";
  }
  return null;
}

function extractQuotedPhrases(query) {
  return [...query.matchAll(/"([^"]+)"/g)].map((match) => match[1].trim()).filter(Boolean);
}

function extractFilenameClues(query) {
  return [...query.matchAll(/\b[\w-]+\.(?:md|txt|json)\b/gi)].map((match) => match[0]);
}

function extractTopicKeywords(query) {
  const quoted = extractQuotedPhrases(query);
  const rawTokens = tokenize(query, { unique: true });
  const keywords = rawTokens.filter((token) => !QUERY_STOPWORDS.has(token));

  return [...new Set([...quoted, ...keywords])].slice(0, 12);
}

export function findRelevantDateRange(analysis) {
  if (analysis.filters.explicitDate) {
    return {
      start: analysis.filters.explicitDate,
      end: analysis.filters.explicitDate,
    };
  }

  if (analysis.filters.month) {
    const [year, month] = analysis.filters.month.split("-");
    const lastDay = new Date(Number(year), Number(month), 0).getDate();
    return {
      start: `${year}-${month}-01`,
      end: `${year}-${month}-${String(lastDay).padStart(2, "0")}`,
    };
  }

  return null;
}

export function analyzeQuery(query) {
  const mode = inferMode(query);
  const month = extractMonthYear(query);
  const explicitDate = extractExplicitDate(query);
  const docTypePreference = inferDocTypePreference(query);
  const filenameClues = extractFilenameClues(query);
  const topicKeywords = extractTopicKeywords(query);
  const dateRange = findRelevantDateRange({
    filters: {
      month,
      explicitDate,
    },
  });

  return {
    mode,
    broadQuery: [
      "recurring_themes",
      "temporal_summary",
      "first_mention",
      "evolution_over_time",
      "comparison",
    ].includes(mode),
    filters: {
      dateRange,
      explicitDate,
      month,
      doc_type: docTypePreference,
      filename_clues: filenameClues,
      topic_keywords: topicKeywords,
    },
  };
}
