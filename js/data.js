/**
 * data.js — Central datahåndtering
 *
 * Indlæser alle datafiler én gang og deler dem med resten af appen.
 * Andre moduler kalder loadData() og venter på det er klar.
 */

import { buildSynonymLookup, buildFieldIndex } from "./search.js";

const DATA_URL = "data/botanik_final.json";
const VOCAB_URL = "data/vocabulary.json";
const SYNONYMS_URL = "data/synonyms.json";
const IMAGE_MANIFEST_URL = "data/image_manifest.json";

export const IMAGES_BASE_URL = "https://pub-9b629f8090a54a769ad120596348dde3.r2.dev";

// Internt state
const state = {
  arter: [],            // alle arter (botanik_final.json)
  vocabulary: {},       // vocabulary.json
  synonyms: {},         // rå synonyms.json
  synonymLookup: {},    // bygget fra synonyms
  fieldIndex: {},       // bygget fra vocabulary
  imageIndex: {},       // image_manifest.json (rå keys)
  imageIndexNorm: {},   // normaliseret key → filenames (for robust lookup)
  byTitle: {},          // hurtig lookup: title → art
  loaded: false,
  loadPromise: null,
};


/**
 * Normaliser en title/key så de kan matches på tværs af stavevarianter.
 * Manifestet bygges fra filnavne (underscore), JSON bruger mellemrum.
 *
 * "Almindelig Hundegræs" → "almindelighundegraes"
 * "Almindelig_Hundegræs" → "almindelighundegraes"
 * "Vej-Pileurt" → "vejpileurt"
 * "Vej Pileurt" → "vejpileurt"
 */
function normalizeKey(s) {
  if (!s) return "";
  let n = String(s).toLowerCase().trim();
  n = n.replace(/[\s\-_]+/g, "");
  n = n.replace(/æ/g, "ae").replace(/ø/g, "oe").replace(/å/g, "aa");
  return n;
}


/** Indlæs alle datafiler. Kalder kun fetch én gang. */
export function loadData() {
  if (state.loadPromise) return state.loadPromise;

  state.loadPromise = (async () => {
    const [arter, vocabulary, synonyms, imageIndex] = await Promise.all([
      fetch(DATA_URL).then(r => r.json()),
      fetch(VOCAB_URL).then(r => r.json()),
      fetch(SYNONYMS_URL).then(r => r.json()),
      fetch(IMAGE_MANIFEST_URL).then(r => r.json()).catch(() => ({})),
    ]);

    state.arter = arter;
    state.vocabulary = vocabulary;
    state.synonyms = synonyms;
    state.imageIndex = imageIndex;
    state.synonymLookup = buildSynonymLookup(synonyms);
    state.fieldIndex = buildFieldIndex(vocabulary);

    // Byg normaliseret image-index for robust lookup
    state.imageIndexNorm = {};
    for (const [key, files] of Object.entries(imageIndex)) {
      const normKey = normalizeKey(key);
      if (normKey) state.imageIndexNorm[normKey] = files;
    }

    // Byg title → art lookup
    state.byTitle = {};
    for (const art of arter) {
      if (art.Title) state.byTitle[art.Title] = art;
    }

    state.loaded = true;
    return state;
  })();

  return state.loadPromise;
}


/** Hent state — kald først efter loadData() er resolved. */
export function getData() {
  return state;
}


/** Find én art ud fra Title (case-sensitive). */
export function findArt(title) {
  return state.byTitle[title] || null;
}


/** Hent billede-URLs for en art (eller tom liste).
 *  Bruger normaliseret lookup så Title med mellemrum matcher manifest-keys
 *  med underscore. */
export function getImageUrls(art) {
  if (!art || !art.Title) return [];

  // Først: prøv direkte lookup (hurtigst, hvis keys matcher præcist)
  let filenames = state.imageIndex[art.Title];

  // Fallback: prøv normaliseret lookup
  if (!filenames || !filenames.length) {
    const normKey = normalizeKey(art.Title);
    filenames = state.imageIndexNorm[normKey] || [];
  }

  return filenames.map(fn => `${IMAGES_BASE_URL}/${encodeURIComponent(fn)}`);
}


// =============================================================================
// SVÆRE ARTER — gemt i localStorage
// =============================================================================

const HARD_KEY = "botanik_svaere_arter_v1";

/** Hent listen af titler markeret som svære. */
export function getHardSpecies() {
  try {
    const raw = localStorage.getItem(HARD_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/** Tilføj eller fjern art fra "svære" listen. Returnerer ny status. */
export function toggleHardSpecies(title) {
  const list = getHardSpecies();
  const idx = list.indexOf(title);
  if (idx >= 0) {
    list.splice(idx, 1);
  } else {
    list.push(title);
  }
  localStorage.setItem(HARD_KEY, JSON.stringify(list));
  return list.includes(title);
}

/** Tjek om en art er på "svære" listen. */
export function isHardSpecies(title) {
  return getHardSpecies().includes(title);
}


// =============================================================================
// VÆGTE — gemt i localStorage
// =============================================================================

const WEIGHTS_KEY = "botanik_search_weights_v1";

export function loadWeights(defaults) {
  try {
    const raw = localStorage.getItem(WEIGHTS_KEY);
    if (raw) {
      return { ...defaults, ...JSON.parse(raw) };
    }
  } catch {}
  return { ...defaults };
}

export function saveWeights(weights) {
  localStorage.setItem(WEIGHTS_KEY, JSON.stringify(weights));
}
