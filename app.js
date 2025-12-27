const DATA_URL = "data/botanik.json";
const IMAGE_MANIFEST_URL = "data/image_manifest.json";
const IMAGES_BASE_URL = "https://pub-9b629f8090a54a769ad120596348dde3.r2.dev";

let cards = [];
let currentCard = null;
let currentFields = [];
let currentFieldIndex = 0;
let filteredCards = [];

// image manifest: artKey -> [filnavne]
let imageIndex = {};

// Elementer
const fieldLabelEl = document.getElementById("field-label");
const fieldContentEl = document.getElementById("field-content");
const answerModal = document.getElementById("answerModal");
const answerTitleEl = document.getElementById("answerTitle");
const cardEl = document.getElementById("card");
const familyBadgeEl = document.getElementById("familyBadge");

const habitattypeFilterEl = document.getElementById("habitattypeFilter");
const familieFilterEl = document.getElementById("familieFilter");
const clearFiltersBtn = document.getElementById("clearFiltersBtn");

const filterToggleBtn = document.getElementById("filterToggleBtn");
const filterPanelEl = document.getElementById("filterPanel");

// Rækkefølgen (hierarki): feltkendetegn -> habitat (bog->naturbasen) -> beskrivelse (bog->naturbasen)
// -> blomstring -> variation -> forvekslingsmuligheder (bog->naturbasen)
const FIELD_ORDER = [
  { key: "Feltkendetegn", type: "text", label: "Feltkendetegn" },

  // Prioritér Bog_* hvis der findes data, ellers brug Naturbasen_*
  { keys: ["Bog_Habitat", "Naturbasen_Habitat"], type: "priority_text", label: "Habitat" },
  { keys: ["Bog_Beskrivelse", "Naturbasen_Kendetegn"], type: "priority_text", label: "Beskrivelse" },

  // Du har omdøbt kolonnen til Naturbasen_blomstring (vi supporterer stadig den gamle key som fallback)
  { keys: ["Naturbasen_blomstring", "Naturbasen_Hvornår ses den?"], type: "priority_text", label: "Blomstring" },

  { key: "Naturbasen_Variation", type: "text", label: "Variation" },

  { keys: ["Bog_Forvekslingsmuligheder", "Naturbasen_Forvekslingsmuligheder"], type: "priority_text", label: "Forvekslingsmuligheder" }
];

// Del Habitattype op i "små enkeltværdier" som Eng, Mose, Overdrev osv.
function splitHabitattypeValues(ht) {
  if (!ht) return [];
  return String(ht)
    .split(/[;,/]/) // del ved ; , eller /
    .map((s) => s.trim())
    .filter(Boolean);
}

// Robust key-lookup (fixer små Unicode/whitespace forskelle i kolonnenavne)
function getCardValue(card, key) {
  if (!card || !key) return undefined;

  if (Object.prototype.hasOwnProperty.call(card, key)) return card[key];

  const target = String(key).trim().normalize("NFC");
  for (const k of Object.keys(card)) {
    if (String(k).trim().normalize("NFC") === target) {
      return card[k];
    }
  }
  return undefined;
}

// Find første ikke-tomme værdi i en prioriteret liste af kolonner
function getFirstNonEmpty(card, keys) {
  for (const k of keys) {
    const v = getCardValue(card, k);
    if (v !== null && v !== undefined && String(v).trim() !== "") {
      return String(v).trim();
    }
  }
  return null;
}

function getActiveCardList() {
  // Hvis der er et aktivt filter, bruger vi filteredCards, ellers alle cards
  return filteredCards.length ? filteredCards : cards;
}

function updateFamilyBadge() {
  if (!familyBadgeEl) return;
  const fam =
    currentCard && currentCard.Familie ? String(currentCard.Familie).trim() : "";
  familyBadgeEl.textContent = fam || "";
}

/**
 * Find billed-key for en art.
 * Vi prøver flere varianter så det virker hvis dine filnavne bruger bindestreger i stedet for mellemrum.
 * Manifestet er bygget ud fra filnavne (alt før sidste underscore).
 */
function getImageKeyCandidates(card) {
  const title = card?.Title ? String(card.Title).trim() : "";
  const bog = card?.Bog_Artsnavn ? String(card.Bog_Artsnavn).trim() : "";
  const nb = card?.Artsnavn_Naturbasen ? String(card.Artsnavn_Naturbasen).trim() : "";

  const base = [title, bog, nb].filter(Boolean);

  const variants = [];
  for (const s of base) {
    variants.push(s);
    variants.push(s.replace(/\s+/g, "-"));     // "Akselblomstret Star" -> "Akselblomstret-Star"
    variants.push(s.replace(/\s+/g, ""));      // "AkselblomstretStar"
    variants.push(s.replace(/\s+/g, "_"));     // "Akselblomstret_Star"
  }

  // unique
  return Array.from(new Set(variants));
}

function pickRandomFromArray(arr, count) {
  if (!Array.isArray(arr) || !arr.length) return [];
  const copy = arr.slice();

  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, Math.min(count, copy.length));
}

/** Returnér op til 5 tilfældige billeder for arten (baseret på manifestet). */
function pickRandomImagesForCard(card, count = 5) {
  const candidates = getImageKeyCandidates(card);
  for (const key of candidates) {
    const list = imageIndex[key];
    if (Array.isArray(list) && list.length) {
      return pickRandomFromArray(list, count);
    }
  }
  return [];
}

// Byg filterværdier til dropdowns ud fra data
function buildFilterOptions() {
  const habitattypeSet = new Set();
  const familieSet = new Set();

  cards.forEach((card) => {
    const ht = card.Habitattype ? String(card.Habitattype).trim() : "";
    const fam = card.Familie ? String(card.Familie).trim() : "";

    if (ht) {
      splitHabitattypeValues(ht).forEach((part) => habitattypeSet.add(part));
    }
    if (fam) familieSet.add(fam);
  });

  habitattypeFilterEl.innerHTML = '<option value="">Alle</option>';
  Array.from(habitattypeSet)
    .sort((a, b) => a.localeCompare(b, "da"))
    .forEach((val) => {
      const opt = document.createElement("option");
      opt.value = val;
      opt.textContent = val;
      habitattypeFilterEl.appendChild(opt);
    });

  familieFilterEl.innerHTML = '<option value="">Alle</option>';
  Array.from(familieSet)
    .sort((a, b) => a.localeCompare(b, "da"))
    .forEach((val) => {
      const opt = document.createElement("option");
      opt.value = val;
      opt.textContent = val;
      familieFilterEl.appendChild(opt);
    });
}

// Anvend filtre på kortlisten
function applyFilters() {
  const selectedHabitattype = habitattypeFilterEl.value;
  const selectedFamilie = familieFilterEl.value;

  // Ingen filtre => brug alle kort
  if (!selectedHabitattype && !selectedFamilie) {
    filteredCards = [];
    return;
  }

  filteredCards = cards.filter((card) => {
    const ht = card.Habitattype ? String(card.Habitattype).trim() : "";
    const fam = card.Familie ? String(card.Familie).trim() : "";

    let matchHt = true;
    if (selectedHabitattype) {
      matchHt = ht.toLowerCase().includes(selectedHabitattype.toLowerCase());
    }

    let matchFam = true;
    if (selectedFamilie) {
      matchFam = fam === selectedFamilie;
    }

    return matchHt && matchFam;
  });
}

function onFilterChange() {
  applyFilters();

  const list = getActiveCardList();
  if (!list.length) {
    currentCard = null;
    currentFields = [];
    fieldLabelEl.textContent = "";
    fieldContentEl.innerHTML = "<p>Ingen kort matcher de valgte filtre.</p>";
    if (familyBadgeEl) familyBadgeEl.textContent = "";
    return;
  }

  pickRandomCard();
}

// Byg liste over felter, tomme springes over
function buildFieldsForCard(card) {
  const fields = [];

  // 1) Fem tilfældige billeder (hvis de findes)
  const pics = pickRandomImagesForCard(card, 5);
  pics.forEach((file, idx) => {
    fields.push({
      type: "image",
      label: `Billede ${idx + 1}`,
      src: `${IMAGES_BASE_URL}/${encodeURIComponent(file)}`
    });
  });

  // 2) Tekstfelter i hierarkisk rækkefølge
  FIELD_ORDER.forEach((spec) => {
    if (spec.type === "priority_text") {
      const text = getFirstNonEmpty(card, spec.keys);
      if (!text) return;

      fields.push({
        type: "text",
        label: spec.label,
        text
      });
      return;
    }

    // normal tekstfelt
    const rawValue = getCardValue(card, spec.key);
    if (!rawValue || String(rawValue).trim() === "") return;

    fields.push({
      type: "text",
      label: spec.label,
      text: String(rawValue).trim()
    });
  });

  return fields;
}

// Vis aktuelt felt
function renderCurrentField() {
  if (!currentFields.length) {
    fieldLabelEl.textContent = "";
    fieldContentEl.innerHTML = "<p>Ingen data til denne art.</p>";
    return;
  }

  const field = currentFields[currentFieldIndex];
  fieldLabelEl.textContent = `${field.label} (${currentFieldIndex + 1}/${currentFields.length})`;

  if (field.type === "image") {
    const altText = (currentCard && currentCard.Title) ? String(currentCard.Title).trim() : "Billede";
    fieldContentEl.innerHTML = `<img loading="lazy" decoding="async" src="${field.src}" alt="${altText}" />`;
  } else {
    fieldContentEl.innerHTML = `<p>${field.text}</p>`;
  }
}

// Ny tilfældig art
function pickRandomCard() {
  const list = getActiveCardList();
  if (!list.length) {
    currentCard = null;
    currentFields = [];
    fieldLabelEl.textContent = "";
    fieldContentEl.innerHTML = "<p>Ingen kort at vise. Tjek evt. filtre.</p>";
    if (familyBadgeEl) familyBadgeEl.textContent = "";
    return;
  }

  const index = Math.floor(Math.random() * list.length);
  currentCard = list[index];
  currentFields = buildFieldsForCard(currentCard);

  if (!currentFields.length) {
    currentFields = [
      {
        type: "text",
        label: "Info",
        text: "Denne art har ingen viste felter (billeder/tekst)."
      }
    ];
  }

  currentFieldIndex = 0;
  updateFamilyBadge();
  renderCurrentField();
}

// Næste/forrige felt (cirkulært)
function nextField() {
  if (!currentFields.length) return;
  currentFieldIndex = (currentFieldIndex + 1) % currentFields.length;
  renderCurrentField();
}

function prevField() {
  if (!currentFields.length) return;
  currentFieldIndex = (currentFieldIndex - 1 + currentFields.length) % currentFields.length;
  renderCurrentField();
}

// Svar-overlay
function openAnswerModal() {
  if (!currentCard) return;
  answerTitleEl.textContent = (currentCard.Title ? String(currentCard.Title).trim() : "") || "Ukendt art";
  answerModal.classList.remove("hidden");
}

function closeAnswerModal() {
  answerModal.classList.add("hidden");
}

// Klik udenfor boksen lukker overlay
answerModal.addEventListener("click", (event) => {
  if (event.target === answerModal) closeAnswerModal();
});

// --- Filtre (under Filter-knappen) ---
function isFilterPanelOpen() {
  return !filterPanelEl.classList.contains("hidden");
}

function openFilterPanel() {
  filterPanelEl.classList.remove("hidden");
  filterToggleBtn.setAttribute("aria-expanded", "true");
}

function closeFilterPanel() {
  filterPanelEl.classList.add("hidden");
  filterToggleBtn.setAttribute("aria-expanded", "false");
}

filterToggleBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (isFilterPanelOpen()) closeFilterPanel();
  else openFilterPanel();
});

filterPanelEl.addEventListener("click", (e) => {
  // klik inde i panelet skal ikke lukke det
  e.stopPropagation();
});

// klik udenfor lukker filterpanelet
document.addEventListener("click", () => {
  if (isFilterPanelOpen()) closeFilterPanel();
});

habitattypeFilterEl.addEventListener("change", onFilterChange);
familieFilterEl.addEventListener("change", onFilterChange);

clearFiltersBtn.addEventListener("click", () => {
  habitattypeFilterEl.value = "";
  familieFilterEl.value = "";
  applyFilters();
  pickRandomCard();
});

// --- Gestures ---
// Simpel swipe på touch (venstre/højre = felter, op = ny art)
let touchStartX = null;
let touchStartY = null;

// Lyt både på kortet og på indholdet (så scroll ikke stjæler swipes)
const swipeTargets = [cardEl, fieldContentEl].filter(Boolean);

function onTouchStart(e) {
  if (e.touches.length === 1) {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  }
}

function onTouchEnd(e) {
  if (touchStartX === null || touchStartY === null) return;

  const endX = e.changedTouches[0].clientX;
  const endY = e.changedTouches[0].clientY;

  const dx = endX - touchStartX;
  const dy = endY - touchStartY;

  const thresholdX = 40;
  const thresholdY = 50;

  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);

  // Lodret swipe: swipe op = ny art
  if (absDy > absDx && dy < -thresholdY) {
    // Undgå konflikt med scroll: kun når indholdet er ved toppen
    if (fieldContentEl.scrollTop === 0) {
      pickRandomCard();
    }
  }

  // Vandret swipe: venstre/højre = felter
  if (absDx > absDy && absDx > thresholdX) {
    if (dx > 0) prevField();
    else nextField();
  }

  touchStartX = null;
  touchStartY = null;
}

swipeTargets.forEach((el) => {
  el.addEventListener("touchstart", onTouchStart, { passive: true });
  el.addEventListener("touchend", onTouchEnd, { passive: true });
});

cardEl.addEventListener("click", () => {
  if (!currentCard) pickRandomCard();
});

cardEl.addEventListener("dblclick", () => {
  if (currentCard) openAnswerModal();
});

// Hent image manifest + data
async function loadImageManifest() {
  try {
    const res = await fetch(IMAGE_MANIFEST_URL);
    const IMAGES_BASE_URL = "https://pub-9b629f8090a54a769ad120596348dde3.r2.dev";
    if (!res.ok) throw new Error("Kunne ikke hente image manifest: " + res.status);
    const json = await res.json();
    imageIndex = (json && typeof json === "object") ? json : {};
  } catch (err) {
    console.warn(err);
    imageIndex = {};
  }
}

async function loadData() {
  try {
    await loadImageManifest();

    const res = await fetch(DATA_URL);
    if (!res.ok) throw new Error("Kunne ikke hente data: " + res.status);

    const json = await res.json();
    cards = Array.isArray(json) ? json : [];

    buildFilterOptions();
  } catch (err) {
    console.error(err);
    fieldContentEl.innerHTML = "<p>Kunne ikke indlæse data (tjek data/botanik.json).</p>";
  }
}

loadData();
