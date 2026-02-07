const DATA_URL = "data/botanik.json";
const IMAGE_MANIFEST_URL = "data/image_manifest.json";
const IMAGES_BASE_URL = "https://pub-9b629f8090a54a769ad120596348dde3.r2.dev";

let cards = [];
let currentCard = null;
let currentFields = [];
let currentFieldIndex = 0;
let filteredCards = [];
let gameType = "arter"; // "arter" | "feltkendetegn"


// image manifest: artKey -> [filnavne]
let imageIndex = {};

// Score
let scoreCorrect = 0;
let scoreTotal = 0;

// Elementer
const fieldLabelEl = document.getElementById("field-label");
const fieldContentEl = document.getElementById("field-content");
const answerModal = document.getElementById("answerModal");
const answerTitleEl = document.getElementById("answerTitle");
const answerFamilyEl = document.getElementById("answerFamily");
const cardEl = document.getElementById("card");
const familyBadgeEl = document.getElementById("familyBadge");
const scoreBadgeEl = document.getElementById("scoreBadge");

const habitattypeFilterEl = document.getElementById("habitattypeFilter");
const familieFilterEl = document.getElementById("familieFilter");
const gameTypeFilterEl = document.getElementById("gameTypeFilter");
const clearFiltersBtn = document.getElementById("clearFiltersBtn");

const filterToggleBtn = document.getElementById("filterToggleBtn");
const filterPanelEl = document.getElementById("filterPanel");

// Rækkefølgen (hierarki): feltkendetegn -> habitat (bog->naturbasen) -> beskrivelse (bog->naturbasen)
// -> blomstring -> variation -> forvekslingsmuligheder (bog->naturbasen)
const FIELD_ORDER = [
  { key: "Feltkendetegn", type: "text", label: "Feltkendetegn" },

  { keys: ["Bog_Habitat", "Naturbasen_Habitat"], type: "priority_text", label: "Habitat" },
  { keys: ["Bog_Beskrivelse", "Naturbasen_Kendetegn"], type: "priority_text", label: "Beskrivelse" },

  { keys: ["Naturbasen_blomstring", "Naturbasen_Hvornår ses den?"], type: "priority_text", label: "Blomstring" },

  { key: "Naturbasen_Variation", type: "text", label: "Variation" },

  { keys: ["Bog_Forvekslingsmuligheder", "Naturbasen_Forvekslingsmuligheder"], type: "priority_text", label: "Forveksling" }
];

// Del Habitattype op i "små enkeltværdier" som Eng, Mose, Overdrev osv.
function splitHabitattypeValues(ht) {
  if (!ht) return [];
  return String(ht)
    .split(/[;,/]/)
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
  const base = filteredCards.length ? filteredCards : cards;

  // I "Feltkendetegn"-mode: kun kort der faktisk har en værdi i Feltkendetegn
  if (gameType === "feltkendetegn") {
    return base.filter((card) => {
      const v = getCardValue(card, "Feltkendetegn");
      return v !== null && v !== undefined && String(v).trim() !== "";
    });
  }

  return base;
}

function updateFamilyBadge() {
  if (!familyBadgeEl) return;
  const fam = currentCard && currentCard.Familie ? String(currentCard.Familie).trim() : "";
  familyBadgeEl.textContent = fam || "";
}

function updateScoreUI() {
  if (!scoreBadgeEl) return;

  scoreBadgeEl.textContent = `${scoreCorrect}/${scoreTotal}`;

  // Ryd classes
  scoreBadgeEl.classList.remove("score-good", "score-bad", "score-neutral");

  if (scoreTotal === 0) {
    scoreBadgeEl.classList.add("score-neutral");
    return;
  }

  if (scoreCorrect > scoreTotal / 2) scoreBadgeEl.classList.add("score-good");
  else if (scoreCorrect < scoreTotal / 2) scoreBadgeEl.classList.add("score-bad");
  else scoreBadgeEl.classList.add("score-neutral");
}

// Registrér svar og gå videre
function registerAnswer(isCorrect) {
  // Hvis der ikke er en aktiv art endnu, så tæller vi ikke – vi starter bare
  if (!currentCard) {
    pickRandomCard();
    return;
  }

  scoreTotal += 1;
  if (isCorrect) scoreCorrect += 1;

  updateScoreUI();
  pickRandomCard();
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
    variants.push(s.replace(/\s+/g, "-"));
    variants.push(s.replace(/\s+/g, ""));
    variants.push(s.replace(/\s+/g, "_"));
  }

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

    if (ht) splitHabitattypeValues(ht).forEach((part) => habitattypeSet.add(part));
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

  if (!selectedHabitattype && !selectedFamilie) {
    filteredCards = [];
    return;
  }

  filteredCards = cards.filter((card) => {
    const ht = card.Habitattype ? String(card.Habitattype).trim() : "";
    const fam = card.Familie ? String(card.Familie).trim() : "";

    let matchHt = true;
    if (selectedHabitattype) matchHt = ht.toLowerCase().includes(selectedHabitattype.toLowerCase());

    let matchFam = true;
    if (selectedFamilie) matchFam = fam === selectedFamilie;

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

    // "Feltkendetegn"-mode: vis KUN Feltkendetegn, og ingen billeder
    if (gameType === "feltkendetegn") {
      const rawValue = getCardValue(card, "Feltkendetegn");
      if (rawValue && String(rawValue).trim() !== "") {
        fields.push({
          type: "text",
          label: "Feltkendetegn",
          text: String(rawValue).trim()
        });
      }
      return fields;
    }

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
      fields.push({ type: "text", label: spec.label, text });
      return;
    }

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

  // Felt-label viser kun navnet (ikke x/x længere)
  fieldLabelEl.textContent = field.label;

  if (field.type === "image") {
    const altText = currentCard?.Title ? String(currentCard.Title).trim() : "Billede";
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
    currentFields = [{ type: "text", label: "Info", text: "Denne art har ingen viste felter (billeder/tekst)." }];
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

  const title = (currentCard.Title ? String(currentCard.Title).trim() : "") || "Ukendt art";
  answerTitleEl.textContent = title;

  const family = currentCard.Familie ? String(currentCard.Familie).trim() : "";

  if (answerFamilyEl) {
    if (family) {
      // Vælg ÉN af de to linjer herunder:

      answerFamilyEl.textContent = family;              // (1) kun familienavn
      // answerFamilyEl.textContent = `Familie: ${family}`; // (2) med label

      answerFamilyEl.classList.remove("hidden");
    } else {
      answerFamilyEl.textContent = "";
      answerFamilyEl.classList.add("hidden");
    }
  }

  answerModal.classList.remove("hidden");
}


function closeAnswerModal() {
  answerModal.classList.add("hidden");
}

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
  e.stopPropagation();
});

document.addEventListener("click", () => {
  if (isFilterPanelOpen()) closeFilterPanel();
});

habitattypeFilterEl.addEventListener("change", onFilterChange);
familieFilterEl.addEventListener("change", onFilterChange);
if (gameTypeFilterEl) {
  gameTypeFilterEl.addEventListener("change", () => {
    gameType = gameTypeFilterEl.value || "arter";
    onFilterChange(); // genbruger eksisterende flow inkl. "Ingen kort matcher..."
  });
}

clearFiltersBtn.addEventListener("click", () => {
  habitattypeFilterEl.value = "";
  familieFilterEl.value = "";
  applyFilters();
  pickRandomCard();
});

// --- Gestures ---
// Swipe venstre/højre = felter
// Swipe op fra bunden = RIGTIGT svar + ny art
// Swipe ned fra toppen = FORKERT svar + ny art
// Multi-touch (pinch-zoom) annullerer swipe.
const thresholdX = 40;
const thresholdY = 70;
const maxSideDrift = 35;

let touchStartX = null;
let touchStartY = null;
let touchStartInBottomZone = false;
let touchStartInTopZone = false;
let gestureCancelled = false;
let touchId = null;

// Lyt både på kortet og på indholdet (så scroll ikke stjæler swipes)
const swipeTargets = [cardEl, fieldContentEl].filter(Boolean);

function resetGestureState() {
  touchStartX = null;
  touchStartY = null;
  touchStartInBottomZone = false;
  touchStartInTopZone = false;
  gestureCancelled = false;
  touchId = null;
}

function onTouchStart(e) {
  if (e.touches.length !== 1) {
    gestureCancelled = true;
    touchStartX = null;
    touchStartY = null;
    touchStartInBottomZone = false;
    touchStartInTopZone = false;
    touchId = null;
    return;
  }

  gestureCancelled = false;

  const t = e.touches[0];
  touchId = t.identifier;
  touchStartX = t.clientX;
  touchStartY = t.clientY;

  // zoner: 15% af skærmen (min 90px)
  const zonePx = Math.max(90, window.innerHeight * 0.15);

  touchStartInTopZone = touchStartY < zonePx;
  touchStartInBottomZone = touchStartY > (window.innerHeight - zonePx);
}

function onTouchMove(e) {
  // Multi-touch => pinch => annullér
  if (e.touches.length > 1) {
    gestureCancelled = true;
    return;
  }
  if (gestureCancelled) return;
  if (touchStartX === null || touchStartY === null) return;

  // Find den aktive finger
  const t =
    Array.from(e.touches).find((tt) => tt.identifier === touchId) ||
    e.touches[0];

  const dx = t.clientX - touchStartX;
  const dy = t.clientY - touchStartY;

  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);

  // Hvis det ligner "swipe ned fra top-zone" og vi står ved toppen,
  // så forhindrer vi browserens pull-to-refresh.
  if (
    touchStartInTopZone &&
    dy > 0 &&
    absDy > absDx * 1.2 &&
    absDx < maxSideDrift &&
    fieldContentEl.scrollTop === 0
  ) {
    e.preventDefault();
  }
}

function onTouchEnd(e) {
  if (touchStartX === null || touchStartY === null) return;

  if (gestureCancelled) {
    resetGestureState();
    return;
  }

  const t =
    Array.from(e.changedTouches).find((tt) => tt.identifier === touchId) ||
    e.changedTouches[0];

  const endX = t.clientX;
  const endY = t.clientY;

  const dx = endX - touchStartX;
  const dy = endY - touchStartY;

  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);

  // RIGTIGT: swipe op fra bunden
  if (
    touchStartInBottomZone &&
    dy < -thresholdY &&
    absDy > absDx * 1.2 &&
    absDx < maxSideDrift
  ) {
    if (fieldContentEl.scrollTop === 0) {
      registerAnswer(true);
      resetGestureState();
      return;
    }
  }

  // FORKERT: swipe ned fra toppen
  if (
    touchStartInTopZone &&
    dy > thresholdY &&
    absDy > absDx * 1.2 &&
    absDx < maxSideDrift
  ) {
    if (fieldContentEl.scrollTop === 0) {
      registerAnswer(false);
      resetGestureState();
      return;
    }
  }

  // Felter: venstre/højre
  if (absDx > absDy && absDx > thresholdX) {
    if (dx > 0) prevField();
    else nextField();
  }

  resetGestureState();
}

function onTouchCancel() {
  resetGestureState();
}

swipeTargets.forEach((el) => {
  el.addEventListener("touchstart", onTouchStart, { passive: true });
  el.addEventListener("touchmove", onTouchMove, { passive: false });
  el.addEventListener("touchend", onTouchEnd, { passive: true });
  el.addEventListener("touchcancel", onTouchCancel, { passive: true });
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
    updateScoreUI(); // init score UI (0/0)
  } catch (err) {
    console.error(err);
    fieldContentEl.innerHTML = "<p>Kunne ikke indlæse data (tjek data/botanik.json).</p>";
  }
}

loadData();
