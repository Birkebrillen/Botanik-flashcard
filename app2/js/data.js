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
  arter: [],          // alle arter (botanik_final.json)
  vocabulary: {},     // vocabulary.json
  synonyms: {},       // rå synonyms.json
  synonymLookup: {},  // bygget fra synonyms
  fieldIndex: {},     // bygget fra vocabulary
  imageIndex: {},     // image_manifest.json
  byTitle: {},        // hurtig lookup: title → art
  loaded: false,
  loadPromise: null,
};


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


/** Hent billede-URLs for en art (eller tom liste). */
export function getImageUrls(art) {
  if (!art || !art.Title) return [];
  const key = art.Title;
  const filenames = state.imageIndex[key] || [];
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
