import { tokenize } from "../indexing/text-utils.js";

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
  "across",
  "all",
  "an",
  "and",
  "are",
  "around",
  "be",
  "between",
  "by",
  "can",
  "daily",
  "date",
  "did",
  "do",
  "does",
  "documents",
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
  "say",
  "show",
  "summarize",
  "summary",
  "tell",
  "that",
  "the",
  "their",
  "them",
  "theme",
  "themes",
  "time",
  "to",
  "what",
  "when",
  "where",
  "which",
  "who",
  "with",
  "year",
]);

const DOMAIN_HINTS = [
  {
    label: "policy",
    pattern: /\bpolicy|policies|rules?\b/,
    docTypes: ["policy"],
  },
  {
    label: "tickets",
    pattern: /\bticket|tickets\b/,
    docTypes: ["support_ticket"],
    departments: ["support"],
  },
  {
    label: "release_notes",
    pattern: /\brelease notes?\b/,
    docTypes: ["release_notes"],
    departments: ["product"],
  },
  {
    label: "incident",
    pattern: /\bincident report|incident reports?|incident\b/,
    docTypes: ["incident_report"],
    departments: ["incidents"],
  },
  {
    label: "postmortem",
    pattern: /\bpostmortem|postmortems\b/,
    docTypes: ["postmortem"],
    departments: ["incidents"],
  },
  {
    label: "meetings",
    pattern: /\bmeeting|meetings|sync|review\b/,
    docTypes: ["meeting_notes"],
  },
  {
    label: "onboarding",
    pattern: /\bonboarding\b/,
    departments: ["onboarding"],
    docTypes: ["process", "checklist", "org_doc"],
  },
  {
    label: "security",
    pattern: /\bsecurity|access|sso|mfa|auth|password reset\b/,
    departments: ["security"],
    docTypes: ["policy", "security_doc"],
  },
  {
    label: "billing",
    pattern: /\bbilling|refund|invoice|payment\b/,
    departments: ["billing"],
    docTypes: ["policy", "billing_doc"],
  },
  {
    label: "support",
    pattern: /\bsupport|sla|weekend support\b/,
    departments: ["support"],
    docTypes: ["policy", "faq", "meeting_notes", "support_ticket"],
  },
  {
    label: "company",
    pattern: /\bcompany|ceo|leadership|office|headcount\b/,
    departments: ["company"],
    docTypes: ["company_overview", "org_doc"],
  },
];

function unique(items) {
  return [...new Set((items || []).filter(Boolean))];
}

function inferMode(query) {
  const lower = query.toLowerCase();

  if (/\bfirst mention|first mentioned|first time|earliest mention\b/.test(lower)) {
    return "first_mention";
  }

  if (
    /\bcompare|comparison|versus|vs\b/.test(lower) ||
    /\bwhat changed between\b/.test(lower) ||
    /\bcompare .* against\b/.test(lower)
  ) {
    return "comparison";
  }

  if (
    /\brecurring|repeated|common|themes?|patterns?|issues? were identified\b/.test(lower)
  ) {
    return "recurring_themes";
  }

  if (
    /\bevolution|evolve|evolved|over time|timeline|how .* changed|how .* evolve|progression\b/.test(lower) ||
    /\bsummarize .* from incident report to postmortem\b/.test(lower)
  ) {
    return "evolution_over_time";
  }

  if (
    /\bsummarize|summary\b/.test(lower) &&
    (/\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/.test(lower) ||
      /\b\d{4}-\d{2}\b/.test(lower) ||
      /\bdaily notes?\b/.test(lower) ||
      /\brelease notes?\b/.test(lower) ||
      /\bincident|postmortem|meeting|tickets?\b/.test(lower))
  ) {
    return "temporal_summary";
  }

  if (/\bwho|what|where|which|how many|how long|do|does|is|are|can\b/.test(lower)) {
    return "fact_lookup";
  }

  return "unsupported / unknown";
}

function extractMonthMentions(query) {
  const lower = query.toLowerCase();
  const matches = [...lower.matchAll(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})\b/g)];
  const months = matches.map(([, monthName, year]) => `${year}-${MONTHS[monthName]}`);

  for (const match of lower.matchAll(/\b(\d{4})[-/](\d{2})\b/g)) {
    months.push(`${match[1]}-${match[2]}`);
  }

  return unique(months);
}

function extractExplicitDate(query) {
  const lower = query.toLowerCase();
  const match = lower.match(/\b(\d{4})[-_/](\d{2})[-_/](\d{2})\b/);
  if (!match) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function collectDomainHints(text) {
  const lower = text.toLowerCase();
  const docTypes = [];
  const departments = [];
  const groups = [];

  for (const hint of DOMAIN_HINTS) {
    if (!hint.pattern.test(lower)) continue;
    docTypes.push(...(hint.docTypes || []));
    departments.push(...(hint.departments || []));
    groups.push(hint.label);
  }

  return {
    docTypes: unique(docTypes),
    departments: unique(departments),
    groups: unique(groups),
  };
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

  return unique([...quoted, ...keywords]).slice(0, 16);
}

function splitComparisonSides(query) {
  const lower = query.toLowerCase();
  const match = lower.match(/compare\s+(.+?)\s+(?:against|versus|vs)\s+(.+)/);
  if (match) {
    return [match[1].trim(), match[2].trim()];
  }

  const betweenMatch = lower.match(/(?:what changed between|compare)\s+(.+?)\s+and\s+(.+)/);
  if (betweenMatch) {
    return [betweenMatch[1].trim(), betweenMatch[2].trim()];
  }

  return [];
}

function buildComparisonPlan(query, months) {
  if (months.length >= 2 && /\brelease notes?\b/i.test(query)) {
    return {
      sides: months.slice(0, 2).map((month) => ({
        label: `release notes ${month}`,
        months: [month],
        ...collectDomainHints("release notes"),
        keywords: [month, "release notes"],
      })),
    };
  }

  if (/\bonboarding\b/i.test(query) && /\borg\b/i.test(query) && /\bprocess\b/i.test(query)) {
    return {
      sides: [
        {
          label: "onboarding org docs",
          docTypes: ["org_doc"],
          departments: ["onboarding"],
          groups: ["onboarding"],
          months: [],
          keywords: ["onboarding", "owner", "lead", "responsibilities", "org"],
        },
        {
          label: "onboarding process docs",
          docTypes: ["process", "checklist"],
          departments: ["onboarding"],
          groups: ["onboarding"],
          months: [],
          keywords: ["onboarding", "process", "checklist", "steps", "launch"],
        },
      ],
    };
  }

  const sideTexts = splitComparisonSides(query);
  if (sideTexts.length < 2) {
    return null;
  }

  return {
    sides: sideTexts.slice(0, 2).map((text, index) => {
      const domain = collectDomainHints(text);
      const sideMonths = extractMonthMentions(text);
      return {
        label: text,
        months: sideMonths.length ? sideMonths : months.length === 2 ? [months[index]] : [],
        docTypes: domain.docTypes,
        departments: domain.departments,
        groups: domain.groups,
        keywords: extractTopicKeywords(text),
      };
    }),
  };
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
  const months = extractMonthMentions(query);
  const explicitDate = extractExplicitDate(query);
  const filenameClues = extractFilenameClues(query);
  const topicKeywords = extractTopicKeywords(query);
  const domainHints = collectDomainHints(query);
  const comparison = mode === "comparison" ? buildComparisonPlan(query, months) : null;
  const month = months.length === 1 ? months[0] : null;
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
      months,
      doc_type: domainHints.docTypes[0] || null,
      doc_types: domainHints.docTypes,
      departments: domainHints.departments,
      groups: domainHints.groups,
      comparison,
      filename_clues: filenameClues,
      topic_keywords: topicKeywords,
    },
  };
}
