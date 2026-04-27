/**
 * search.js — Søgemotor til botanik-appen (v2 med vægtning)
 */


// =============================================================================
// 1. KONFIGURATION — vægte pr. kategori
// =============================================================================

export const DEFAULT_WEIGHTS = {
  // Meget høj vægt — stærke artsindikatorer
  stikord_primær: 4.0,
  familie: 3.0,
  slægt: 3.0,

  // Høj vægt — stabile morfologiske kendetegn
  frugttype: 2.5,
  stængel_form: 2.5,
  stængelmarv: 2.5,
  blomster_form: 2.5,

  // Middel-høj vægt
  bladform: 2.0,
  bladrand: 2.0,
  bladtype: 2.0,
  blomsterfarve: 2.0,
  vækstform: 2.0,
  særtræk: 2.0,
  lugt: 2.0,

  // Middel vægt
  stikord_sekundær: 1.5,
  bladstilling: 1.5,
  stængel_overflade: 1.5,
  livscyklus: 1.5,

  // Lav vægt — variable træk
  blad_overflade: 1.0,
  habitat: 1.0,
  fugtighed: 1.0,

  // Meget lav vægt — kontekst
  næring: 0.8,
  jord: 0.8,
  lys: 0.8,
  højde: 0.7,
  blomstring: 0.7,
  anvendelse: 0.5,

  // Specielle felter (matches på fritekst)
  title: 3.0,
  feltkendetegn: 1.5,
};


function getWeight(field, weights) {
  if (weights && weights[field] !== undefined) return weights[field];
  return 1.0;
}


// =============================================================================
// 2. NORMALISERING & FUZZY MATCH
// =============================================================================

function normalize(str) {
  if (!str) return "";
  let s = String(str).toLowerCase().trim();
  s = s.replace(/\s+/g, " ");
  const suffixes = ["familien", "slægten", "agtige", "agtig"];
  for (const suf of suffixes) {
    if (s.length > suf.length + 2 && s.endsWith(suf)) {
      s = s.slice(0, -suf.length);
      break;
    }
  }
  return s;
}


function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  if (Math.abs(a.length - b.length) > 3) return Math.abs(a.length - b.length);

  const m = a.length, n = b.length;
  const prev = new Array(n + 1);
  const curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return prev[n];
}


function fuzzyMatch(searchTerm, target, synonymLookup) {
  const a = normalize(searchTerm);
  const b = normalize(target);
  if (!a || !b) return 0;

  if (a === b) return 1.0;

  const synA = synonymLookup[a] || [];
  for (const syn of synA) {
    if (normalize(syn) === b) return 0.95;
  }
  const synB = synonymLookup[b] || [];
  for (const syn of synB) {
    if (normalize(syn) === a) return 0.95;
  }

  if (b.includes(a) && a.length >= 3) return 0.85;
  if (a.includes(b) && b.length >= 3) return 0.7;

  if (a.length >= 4 && b.length >= 4) {
    const dist = levenshtein(a, b);
    const maxLen = Math.max(a.length, b.length);
    const tolerance = Math.floor(maxLen / 5) + 1;
    if (dist <= tolerance) {
      return 0.75 - (dist / maxLen) * 0.5;
    }
  }
  return 0;
}


// =============================================================================
// 3. SYNONYM-LOOKUP
// =============================================================================

export function buildSynonymLookup(synonyms) {
  const lookup = {};
  for (const [key, arr] of Object.entries(synonyms)) {
    const allTerms = [key, ...arr].map(normalize);
    for (const term of allTerms) {
      if (!lookup[term]) lookup[term] = new Set();
      for (const other of allTerms) {
        if (other !== term) lookup[term].add(other);
      }
    }
  }
  const result = {};
  for (const [k, v] of Object.entries(lookup)) result[k] = [...v];
  return result;
}


// =============================================================================
// 4. FIELD-INDEX — fra ord til hvilke kategorier de tilhører
// =============================================================================

export function buildFieldIndex(vocabulary) {
  const index = {};
  for (const [field, items] of Object.entries(vocabulary)) {
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      const value = typeof item === "string" ? item : item.value;
      if (!value) continue;
      const norm = normalize(value);
      if (!index[norm]) index[norm] = new Set();
      index[norm].add(field);
      for (const word of String(value).split(/\s+/)) {
        const wnorm = normalize(word);
        if (wnorm.length >= 4) {
          if (!index[wnorm]) index[wnorm] = new Set();
          index[wnorm].add(field);
        }
      }
    }
  }
  const result = {};
  for (const [k, v] of Object.entries(index)) result[k] = [...v];
  return result;
}


// =============================================================================
// 5. SØG PÅ ARTSNAVN
// =============================================================================

export function searchByName(query, data, limit = 20) {
  const q = normalize(query);
  if (!q) {
    return data.slice().sort((a, b) =>
      (a.Title || "").localeCompare(b.Title || "", "da")
    ).slice(0, limit);
  }

  const scored = [];
  for (const art of data) {
    const title = normalize(art.Title || "");
    const slaegt = normalize(art.slægt || "");

    let score = 0;
    if (title === q) score = 100;
    else if (title.startsWith(q)) score = 80;
    else if (title.includes(q)) score = 60;
    else if (slaegt === q) score = 50;
    else if (slaegt.includes(q)) score = 30;
    else {
      const dist = levenshtein(q, title);
      const tol = Math.max(1, Math.floor(q.length / 4));
      if (dist <= tol && q.length >= 3) score = 35 - dist * 5;

      if (score === 0) {
        const titleWords = title.split(/[\s\-]+/);
        for (const w of titleWords) {
          if (w.length >= 3) {
            const d = levenshtein(q, w);
            const t = Math.max(1, Math.floor(Math.max(q.length, w.length) / 4));
            if (d <= t) {
              score = Math.max(score, 30 - d * 5);
            }
          }
        }
      }
    }

    if (score > 0) scored.push({ art, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(x => x.art);
}


// =============================================================================
// 6. SØG PÅ KENDETEGN — vægtet hybrid
// =============================================================================

function tokenize(query) {
  if (!query) return [];
  return query
    .toLowerCase()
    .split(/[\s,.;!?]+/)
    .map(s => s.trim())
    .filter(s => s.length >= 2);
}


const STRUCTURED_FIELDS = [
  "plantegruppe", "vækstform", "højde", "livscyklus",
  "stængel_form", "stængel_overflade", "stængelmarv",
  "bladstilling", "bladform", "bladrand", "bladtype", "blad_overflade",
  "blomsterfarve", "blomster_form", "frugttype",
  "fugtighed", "næring", "jord", "lys",
  "særtræk", "lugt", "anvendelse", "habitat", "blomstring"
];

const STIKORD_FIELDS = ["stikord_primær", "stikord_sekundær"];


function matchTokenAgainstArt(token, art, synonymLookup) {
  const fieldMatches = {};
  const tags = art.tags || {};

  // Title, slægt, familie
  const meta = [
    { field: "title", value: art.Title },
    { field: "slægt", value: art.slægt },
    { field: "familie", value: art.familie },
  ];
  for (const { field, value } of meta) {
    if (!value) continue;
    const m = fuzzyMatch(token, value, synonymLookup);
    if (m > 0) fieldMatches[field] = Math.max(fieldMatches[field] || 0, m);
    for (const w of String(value).split(/[\s\-]+/)) {
      if (w.length >= 4) {
        const m2 = fuzzyMatch(token, w, synonymLookup);
        if (m2 > 0) fieldMatches[field] = Math.max(fieldMatches[field] || 0, m2);
      }
    }
  }

  // Strukturerede tags
  for (const field of STRUCTURED_FIELDS) {
    const values = tags[field] || [];
    for (const v of values) {
      const m = fuzzyMatch(token, v, synonymLookup);
      if (m > 0) fieldMatches[field] = Math.max(fieldMatches[field] || 0, m);
    }
  }

  // Stikord
  for (const field of STIKORD_FIELDS) {
    const values = tags[field] || [];
    for (const v of values) {
      const m = fuzzyMatch(token, v, synonymLookup);
      if (m > 0) fieldMatches[field] = Math.max(fieldMatches[field] || 0, m);
      for (const w of String(v).split(/\s+/)) {
        if (w.length >= 4) {
          const m2 = fuzzyMatch(token, w, synonymLookup);
          if (m2 > 0) fieldMatches[field] = Math.max(fieldMatches[field] || 0, m2);
        }
      }
    }
  }

  // Feltkendetegn
  if (art.Feltkendetegn) {
    for (const w of art.Feltkendetegn.split(/\s+/)) {
      if (w.length >= 4) {
        const m = fuzzyMatch(token, w, synonymLookup);
        if (m > 0) fieldMatches.feltkendetegn = Math.max(fieldMatches.feltkendetegn || 0, m);
      }
    }
  }

  return fieldMatches;
}


export function searchByCharacteristics(
  freeText, filters, data, synonymLookup, options = {}
) {
  const weights = options.weights || DEFAULT_WEIGHTS;
  const fieldIndex = options.fieldIndex || {};
  const limit = options.limit || 10;
  const missingPenalty = options.missingDataPenalty ?? 0.3;

  const tokens = tokenize(freeText);
  const preferences = filters.preferences || {};

  const hardFilters = {
    niveau: filters.niveau || null,
    plantegruppe: new Set((filters.plantegruppe || []).map(normalize)),
    familie: new Set((filters.familie || []).map(normalize)),
    slægt: new Set((filters.slægt || []).map(normalize)),
  };

  const hasAnyFilter =
    hardFilters.niveau ||
    hardFilters.plantegruppe.size > 0 ||
    hardFilters.familie.size > 0 ||
    hardFilters.slægt.size > 0;

  const hasAnyPref = Object.values(preferences)
    .some(v => Array.isArray(v) && v.length > 0);

  const results = [];

  for (const art of data) {
    // Hårde filtre
    if (hardFilters.niveau && art.niveau !== hardFilters.niveau) continue;
    if (hardFilters.plantegruppe.size > 0) {
      const pg = (art.tags && art.tags.plantegruppe) || [];
      if (!pg.some(v => hardFilters.plantegruppe.has(normalize(v)))) continue;
    }
    if (hardFilters.familie.size > 0) {
      if (!art.familie || !hardFilters.familie.has(normalize(art.familie))) continue;
    }
    if (hardFilters.slægt.size > 0) {
      if (!art.slægt || !hardFilters.slægt.has(normalize(art.slægt))) continue;
    }

    let score = 0;
    const breakdown = { tokens: {}, preferences: {} };

    // Fritekst tokens
    for (const token of tokens) {
      const fieldMatches = matchTokenAgainstArt(token, art, synonymLookup);
      let bestForToken = 0;
      let bestField = null;
      for (const [field, matchScore] of Object.entries(fieldMatches)) {
        const weighted = matchScore * getWeight(field, weights);
        if (weighted > bestForToken) {
          bestForToken = weighted;
          bestField = field;
        }
      }
      const tokenCategories = fieldIndex[normalize(token)] || [];
      if (bestField && tokenCategories.includes(bestField)) {
        bestForToken *= 1.3;
      }
      if (bestForToken > 0) {
        score += bestForToken;
        breakdown.tokens[token] = { field: bestField, score: bestForToken.toFixed(2) };
      }
    }

    // Vægtede præferencer
    for (const [field, prefValues] of Object.entries(preferences)) {
      if (!Array.isArray(prefValues) || prefValues.length === 0) continue;
      const artValues = (art.tags && art.tags[field]) || [];
      const w = getWeight(field, weights);

      if (artValues.length === 0) {
        score -= missingPenalty * w;
        breakdown.preferences[field] = `(mangler) -${(missingPenalty * w).toFixed(2)}`;
        continue;
      }

      let prefMatch = 0;
      for (const pref of prefValues) {
        for (const av of artValues) {
          const m = fuzzyMatch(pref, av, synonymLookup);
          if (m > prefMatch) prefMatch = m;
        }
      }
      if (prefMatch > 0) {
        const bonus = prefMatch * w * 1.5;
        score += bonus;
        breakdown.preferences[field] = `+${bonus.toFixed(2)}`;
      } else {
        score -= missingPenalty * w * 1.5;
        breakdown.preferences[field] = `(mismatch) -${(missingPenalty * w * 1.5).toFixed(2)}`;
      }
    }

    // Alle-tokens-matched bonus
    if (tokens.length > 0) {
      const matchedCount = Object.keys(breakdown.tokens).length;
      if (matchedCount === tokens.length) {
        score *= 1.3;
      }
    }

    // Inkluder hvis der er noget at score på, eller hvis kun filtre er sat
    if (score > 0) {
      results.push({ art, score, breakdown });
    } else if (tokens.length === 0 && !hasAnyPref && hasAnyFilter) {
      // Ingen scoring, kun hårde filtre — alle der overlevede inkluderes
      results.push({ art, score: 1, breakdown });
    }
  }

  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (a.art.Title || "").localeCompare(b.art.Title || "", "da");
  });

  return results.slice(0, limit);
}


// =============================================================================
// 7. EKSPORT
// =============================================================================

export const _testHelpers = {
  normalize,
  levenshtein,
  fuzzyMatch,
  tokenize,
  matchTokenAgainstArt,
};
