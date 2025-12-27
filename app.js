const DATA_URL = "data/botanik.json";

let cards = [];
let currentCard = null;
let currentFields = [];
let currentFieldIndex = 0;
let filteredCards = [];

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

// Rækkefølgen (hierarki): billeder -> feltkendetegn -> habitat (bog->naturbasen) -> beskrivelse (bog->naturbasen)
// -> hvornår ses den? -> variation -> forvekslingsmuligheder (bog->naturbasen)
const FIELD_ORDER = [
  { key: "Billede", type: "image", label: "Billede 1" },
  { key: "Billede2", type: "image", label: "Billede 2" },
  { key: "Billede3", type: "image", label: "Billede 3" },
  { key: "Billede4", type: "image", label: "Billede 4" },
  { key: "Billede5", type: "image", label: "Billede 5" },

  { key: "Feltkendetegn", type: "text", label: "Feltkendetegn" },

  // Prioritér Bog_* hvis der findes data, ellers brug Naturbasen_*
  { keys: ["Bog_Habitat", "Naturbasen_Habitat"], type: "priority_text", label: "Habitat" },
  { keys: ["Bog_Beskrivelse", "Naturbasen_Kendetegn"], type: "priority_text", label: "Beskrivelse" },

  { key: "Naturbasen_Hvornår ses den?", type: "text", label: "Hvornår ses den?" },
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

// Find første ikke-tomme værdi i en prioriteret liste af kolonner
function getFirstNonEmpty(card, keys) {
  for (const k of keys) {
    const v = card[k];
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

// Hjælpefunktion: lav billedfilnavn ud fra JSON-string i Billede-feltet
function extractImageFileName(cellValue) {
  if (!cellValue || typeof cellValue !== "string") return null;

  try {
    const obj = JSON.parse(cellValue);
    const base = obj.originalImageName;
    const fileName = obj.fileName || "";
    if (!base) return null;

    const match = fileName.match(/\.(jpg|jpeg|png|gif|webp)$/i);
    const ext = match ? match[0] : ".jpg"; // fallback
    return base + ext;
  } catch (e) {
    console.warn("Kunne ikke parse billedfelt:", e);
    return null;
  }
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

  FIELD_ORDER.forEach((spec) => {
    if (spec.type === "image") {
      const rawValue = card[spec.key];
      const fileName = extractImageFileName(rawValue);
      if (!fileName) return;

      fields.push({
        type: "image",
        label: spec.label,
        src: "images/" + fileName
      });
      return;
    }

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
    const rawValue = card[spec.key];
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
  fieldLabelEl.textContent = field.label;

  if (field.type === "image") {
    const altText = (currentCard && currentCard.Title) ? currentCard.Title : "Billede";
    fieldContentEl.innerHTML = `<img src="${field.src}" alt="${altText}" />`;
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

cardEl.addEventListener("touchstart", (e) => {
  if (e.touches.length === 1) {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  }
}, { passive: true });

cardEl.addEventListener("touchend", (e) => {
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
}, { passive: true });

cardEl.addEventListener("click", () => {
  if (!currentCard) pickRandomCard();
});

cardEl.addEventListener("dblclick", () => {
  if (currentCard) openAnswerModal();
});

// Hent data
async function loadData() {
  try {
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
