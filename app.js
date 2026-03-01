const DATA_URL = "data/botanik.json";
const IMAGE_MANIFEST_URL = "data/image_manifest.json";
const IMAGES_BASE_URL = "https://pub-9b629f8090a54a769ad120596348dde3.r2.dev";

let cards = [];
let currentCard = null;
let currentFields = [];
let currentFieldIndex = 0;
let filteredCards = [];
let gameType = "arter"; // "arter" | "feltkendetegn" | "husk_feltkendetegn" | *_20

// Søgning (opslagsværk)
let searchQuery = "";

// 20-pulje
const ROUND_POOL_SIZE = 20;
let roundPool = [];               // queue: [næste, ... resten]
let roundSize = 0;                // faktisk puljestørrelse (min(20, eligible))
let roundTransitioning = false;   // kort “20/20”-visning ved rundens slut
let roundTransitionTimeoutId = null;
const ROUND_COMPLETE_DELAY_MS = 350;

// image manifest: artKey -> [filnavne]
let imageIndex = {};

// Score (global historik)
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

// Filtre / UI
const habitattypeFilterEl = document.getElementById("habitattypeFilter");
const familieFilterEl = document.getElementById("familieFilter");
const gameTypeFilterEl = document.getElementById("gameTypeFilter");
const clearFiltersBtn = document.getElementById("clearFiltersBtn");

// Søg UI
const searchToggleBtn = document.getElementById("searchToggleBtn");
const searchPanelEl = document.getElementById("searchPanel");
const searchInputEl = document.getElementById("searchInput");

// Filter UI
const filterToggleBtn = document.getElementById("filterToggleBtn");
const filterPanelEl = document.getElementById("filterPanel");

// Rækkefølgen (hierarki)
const FIELD_ORDER = [
  { key: "Feltkendetegn", type: "text", label: "Feltkendetegn" },

  { keys: ["Bog_Habitat", "Naturbasen_Habitat"], type: "priority_text", label: "Habitat" },
  { keys: ["Bog_Beskrivelse", "Naturbasen_Kendetegn"], type: "priority_text", label: "Beskrivelse" },

  //{ keys: ["Naturbasen_blomstring", "Naturbasen_Hvornår ses den?"], type: "priority_text", label: "Blomstring" },

  { key: "Naturbasen_Variation", type: "text", label: "Variation" },

  { keys: ["Bog_Forvekslingsmuligheder", "Naturbasen_Forvekslingsmuligheder"], type: "priority_text", label: "Forveksling" }
];

// Del Habitattype op i "små enkeltværdier"
function splitHabitattypeValues(ht) {
  if (!ht) return [];
  return String(ht)
    .split(/[;,/]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Robust key-lookup
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

function isNonEmpty(v) {
  return v !== null && v !== undefined && String(v).trim() !== "";
}

// Find første ikke-tomme værdi i en prioriteret liste
function getFirstNonEmpty(card, keys) {
  for (const k of keys) {
    const v = getCardValue(card, k);
    if (isNonEmpty(v)) return String(v).trim();
  }
  return null;
}

function hasNonEmptyFeltkendetegn(card) {
  const v = getCardValue(card, "Feltkendetegn");
  return isNonEmpty(v);
}

// ---- Modes ----
function isRoundMode() {
  return String(gameType).endsWith("_20");
}

function getBaseGameType() {
  return isRoundMode() ? String(gameType).replace(/_20$/, "") : gameType;
}

// ---- Checkbox filter helpers ----
function getCheckedValues(containerEl) {
  if (!containerEl) return [];
  return Array.from(containerEl.querySelectorAll('input[type="checkbox"]:checked'))
    .map((el) => String(el.value || "").trim())
    .filter(Boolean);
}

function clearChecked(containerEl) {
  if (!containerEl) return;
  containerEl.querySelectorAll('input[type="checkbox"]').forEach((cb) => { cb.checked = false; });
}

function renderCheckboxList(containerEl, values, idPrefix) {
  containerEl.innerHTML = "";
  values.forEach((val, idx) => {
    const label = document.createElement("label");
    label.className = "checkbox-item";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = val;
    input.id = `${idPrefix}-${idx}`;

    const span = document.createElement("span");
    span.textContent = val;

    label.appendChild(input);
    label.appendChild(span);
    containerEl.appendChild(label);
  });
}

// ---- Random helpers ----
function pickRandomFromArray(arr, count) {
  if (!Array.isArray(arr) || !arr.length) return [];
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, Math.min(count, copy.length));
}

// ---- Søg helpers (bedste match på Title) ----
function normalizeText(s) {
  if (s === null || s === undefined) return "";
  return String(s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")  // fjern diakritik
    .replace(/[^a-z0-9\s]/g, " ")     // fjern tegnsætning
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(s) {
  const t = normalizeText(s);
  return t ? t.split(" ") : [];
}

function scoreTitleMatch(query, title) {
  const qTokens = tokenize(query);
  const tTokens = tokenize(title);

  if (!qTokens.length || !tTokens.length) return 0;

  let score = 0;
  let lastMatchIndex = -1;

  for (const q of qTokens) {
    let bestIndex = -1;
    let bestTokenScore = 0;

    for (let i = 0; i < tTokens.length; i++) {
      const tt = tTokens[i];

      if (tt === q) {
        bestIndex = i;
        bestTokenScore = Math.max(bestTokenScore, 30);
      } else if (tt.startsWith(q)) {
        const ratio = q.length / Math.max(1, tt.length);
        bestIndex = i;
        bestTokenScore = Math.max(bestTokenScore, 20 + Math.round(ratio * 10));
      } else if (tt.includes(q) && q.length >= 3) {
        bestIndex = i;
        bestTokenScore = Math.max(bestTokenScore, 8);
      }
    }

    if (bestIndex === -1) return 0;

    if (bestIndex >= lastMatchIndex) score += 5;
    lastMatchIndex = bestIndex;

    score += bestTokenScore;
  }

  const qNorm = normalizeText(query);
  const tNorm = normalizeText(title);
  if (qNorm && tNorm.includes(qNorm)) score += 10;

  return score;
}

function getBestMatchCard(cardsList, query) {
  const q = normalizeText(query);
  if (!q) return null;

  let best = null;
  let bestScore = 0;

  for (const card of cardsList) {
    const title = card?.Title ? String(card.Title) : "";
    const s = scoreTitleMatch(q, title);
    if (s > bestScore) {
      bestScore = s;
      best = card;
    }
  }
  return best;
}

// ---- Liste-udvælgelse (filtre + base mode) ----
function getFilteredBaseList() {
  return filteredCards.length ? filteredCards : cards;
}

function getEligibleListForCurrentMode() {
  const base = getFilteredBaseList();
  const mode = getBaseGameType();

  // NOTE: søgning skal IKKE filtrere flashcards; den vælger kun en art når du trykker Enter
  if (mode === "feltkendetegn" || mode === "husk_feltkendetegn") {
    return base.filter(hasNonEmptyFeltkendetegn);
  }
  return base;
}

// ---- 20-runde helpers ----
function cancelRoundTransition() {
  if (roundTransitionTimeoutId !== null) {
    clearTimeout(roundTransitionTimeoutId);
    roundTransitionTimeoutId = null;
  }
  roundTransitioning = false;
}

function rebuildRoundPool() {
  cancelRoundTransition();
  const eligible = getEligibleListForCurrentMode();
  roundPool = pickRandomFromArray(eligible, ROUND_POOL_SIZE);
  roundSize = roundPool.length;
}

function getActiveCardList() {
  if (isRoundMode()) return roundPool;
  return getEligibleListForCurrentMode();
}

// ---- Prioritér første felt ved søgning ----
function applySearchPriorityToFields(card, fields) {
  const fk = getCardValue(card, "Feltkendetegn");
  if (isNonEmpty(fk)) {
    return moveOrInsertTextFieldFirst(fields, "Feltkendetegn", String(fk).trim());
  }

  const forv = getFirstNonEmpty(card, ["Bog_Forvekslingsmuligheder", "Naturbasen_Forvekslingsmuligheder"]);
  if (isNonEmpty(forv)) {
    return moveOrInsertTextFieldFirst(fields, "Forveksling", String(forv).trim());
  }

  return fields;
}

function moveOrInsertTextFieldFirst(fields, label, text) {
  const copy = Array.isArray(fields) ? fields.slice() : [];
  const idx = copy.findIndex((f) => f && f.type === "text" && f.label === label && isNonEmpty(f.text));
  if (idx >= 0) {
    const [f] = copy.splice(idx, 1);
    copy.unshift(f);
    return copy;
  }
  copy.unshift({ type: "text", label, text });
  return copy;
}

function ensureHintImageSecond(card, fields) {
  const copy = Array.isArray(fields) ? fields.slice() : [];
  const hasImg = copy.some((f) => f && f.type === "image");
  if (hasImg) return copy;

  const pics = pickRandomImagesForCard(card, 1);
  if (!pics.length) return copy;

  const imgField = {
    type: "image",
    label: "Billede",
    src: `${IMAGES_BASE_URL}/${encodeURIComponent(pics[0])}`
  };

  if (copy.length >= 1) copy.splice(1, 0, imgField);
  else copy.push(imgField);

  return copy;
}

// ---- UI helpers ----
function updateFamilyBadge() {
  if (!familyBadgeEl) return;
  const fam = currentCard && currentCard.Familie ? String(currentCard.Familie).trim() : "";
  familyBadgeEl.textContent = fam || "";
}

function updateScoreUI() {
  if (!scoreBadgeEl) return;

  let shownCorrect = scoreCorrect;
  let shownTotal = scoreTotal;

  if (isRoundMode()) {
    const denom = roundSize || 0;
    const correct = denom ? (denom - roundPool.length) : 0;
    shownCorrect = correct;
    shownTotal = denom;
    scoreBadgeEl.textContent = `${shownCorrect}/${shownTotal}`;
  } else {
    scoreBadgeEl.textContent = `${shownCorrect}/${shownTotal}`;
  }

  scoreBadgeEl.classList.remove("score-good", "score-bad", "score-neutral");
  if (isRoundMode()) { scoreBadgeEl.classList.add("score-neutral"); return; }

  if (shownTotal === 0) {
    scoreBadgeEl.classList.add("score-neutral");
    return;
  }

  if (shownCorrect > shownTotal / 2) scoreBadgeEl.classList.add("score-good");
  else if (shownCorrect < shownTotal / 2) scoreBadgeEl.classList.add("score-bad");
  else scoreBadgeEl.classList.add("score-neutral");
}

// Registrér svar og gå videre
function registerAnswer(isCorrect) {
  if (!currentCard) {
    pickRandomCard();
    return;
  }

  scoreTotal += 1;
  if (isCorrect) scoreCorrect += 1;

  if (isRoundMode()) {
    const first = roundPool[0];

    if (first === currentCard) {
      roundPool.shift();
      if (!isCorrect) roundPool.push(currentCard);
    } else {
      const idx = roundPool.indexOf(currentCard);
      if (idx >= 0) {
        roundPool.splice(idx, 1);
        if (!isCorrect) roundPool.push(currentCard);
      }
    }

    updateScoreUI();

    if (roundPool.length === 0 && roundSize > 0) {
      roundTransitioning = true;

      currentCard = null;
      currentFields = [];
      currentFieldIndex = 0;
      fieldLabelEl.textContent = "";
      fieldContentEl.innerHTML = `<p>${roundSize}/${roundSize} – ny pulje…</p>`;
      if (familyBadgeEl) familyBadgeEl.textContent = "";

      roundTransitionTimeoutId = setTimeout(() => {
        roundTransitionTimeoutId = null;
        roundTransitioning = false;
        rebuildRoundPool();
        updateScoreUI();
        pickRandomCard();
      }, ROUND_COMPLETE_DELAY_MS);

      return;
    }

    pickRandomCard();
    return;
  }

  updateScoreUI();
  pickRandomCard();
}

/**
 * Find billed-key for en art (manifestet er bygget ud fra filnavne)
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

// Byg filterværdier til checkbox-lister ud fra data
function buildFilterOptions() {
  const habitattypeSet = new Set();
  const familieSet = new Set();

  cards.forEach((card) => {
    const ht = card.Habitattype ? String(card.Habitattype).trim() : "";
    const fam = card.Familie ? String(card.Familie).trim() : "";

    if (ht) splitHabitattypeValues(ht).forEach((part) => habitattypeSet.add(part));
    if (fam) familieSet.add(fam);
  });

  const htValues = Array.from(habitattypeSet).sort((a, b) => a.localeCompare(b, "da"));
  const famValues = Array.from(familieSet).sort((a, b) => a.localeCompare(b, "da"));

  renderCheckboxList(habitattypeFilterEl, htValues, "ht");
  renderCheckboxList(familieFilterEl, famValues, "fam");
}

// Anvend filtre på kortlisten (multi: OR indenfor hver gruppe, AND mellem grupper)
function applyFilters() {
  const selectedHabitats = getCheckedValues(habitattypeFilterEl);
  const selectedFamilies = getCheckedValues(familieFilterEl);

  if (!selectedHabitats.length && !selectedFamilies.length) {
    filteredCards = [];
    return;
  }

  const selectedHabitatsLower = selectedHabitats.map((s) => s.toLowerCase());
  const selectedFamiliesLower = selectedFamilies.map((s) => s.toLowerCase());

  filteredCards = cards.filter((card) => {
    const htRaw = card.Habitattype ? String(card.Habitattype).trim() : "";
    const famRaw = card.Familie ? String(card.Familie).trim() : "";

    let matchHt = true;
    if (selectedHabitatsLower.length) {
      const partsLower = splitHabitattypeValues(htRaw).map((p) => p.toLowerCase());
      matchHt = selectedHabitatsLower.some((sel) => partsLower.includes(sel));
    }

    let matchFam = true;
    if (selectedFamiliesLower.length) {
      matchFam = selectedFamiliesLower.includes(famRaw.toLowerCase());
    }

    return matchHt && matchFam;
  });
}

function onFilterChange() {
  cancelRoundTransition();
  applyFilters();

  if (isRoundMode()) rebuildRoundPool();

  const list = getActiveCardList();
  if (!list.length) {
    currentCard = null;
    currentFields = [];
    fieldLabelEl.textContent = "";
    fieldContentEl.innerHTML = "<p>Ingen kort matcher de valgte filtre.</p>";
    if (familyBadgeEl) familyBadgeEl.textContent = "";
    updateScoreUI();
    return;
  }

  updateScoreUI();
  pickRandomCard();
}

// Byg liste over felter (flashcards)
function buildFieldsForCard(card) {
  const fields = [];
  const mode = getBaseGameType();

  // MODE: Feltkendetegn (Feltkendetegn + 1 hint-billede)
  if (mode === "feltkendetegn") {
    const rawValue = getCardValue(card, "Feltkendetegn");
    if (isNonEmpty(rawValue)) {
      fields.push({
        type: "text",
        label: "Feltkendetegn",
        text: String(rawValue).trim()
      });

      const pics = pickRandomImagesForCard(card, 1);
      if (pics.length) {
        fields.push({
          type: "image",
          label: "Billede",
          src: `${IMAGES_BASE_URL}/${encodeURIComponent(pics[0])}`
        });
      }
    }
    return fields;
  }

  // MODE: Husk feltkendetegn (Artsnavn først + 1 hint-billede)
  if (mode === "husk_feltkendetegn") {
    const title = (card?.Title ? String(card.Title).trim() : "") || "Ukendt art";

    fields.push({
      type: "text",
      label: "Artsnavn",
      text: title
    });

    const pics = pickRandomImagesForCard(card, 1);
    if (pics.length) {
      fields.push({
        type: "image",
        label: "Billede",
        src: `${IMAGES_BASE_URL}/${encodeURIComponent(pics[0])}`
      });
    }

    return fields;
  }

  // MODE: Arter (som før)
  const pics = pickRandomImagesForCard(card, 5);
  pics.forEach((file, idx) => {
    fields.push({
      type: "image",
      label: `Billede ${idx + 1}`,
      src: `${IMAGES_BASE_URL}/${encodeURIComponent(file)}`
    });
  });

  FIELD_ORDER.forEach((spec) => {
    if (spec.type === "priority_text") {
      const text = getFirstNonEmpty(card, spec.keys);
      if (!text) return;
      fields.push({ type: "text", label: spec.label, text });
      return;
    }

    const rawValue = getCardValue(card, spec.key);
    if (!isNonEmpty(rawValue)) return;

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
  const mode = getBaseGameType();

  fieldLabelEl.textContent = field.label;

  fieldContentEl.classList.remove("big-center");
  if (mode === "husk_feltkendetegn" && field.type === "text" && field.label === "Artsnavn") {
    fieldContentEl.classList.add("big-center");
  }

  if (field.type === "image") {
    const altText = currentCard?.Title ? String(currentCard.Title).trim() : "Billede";
    fieldContentEl.innerHTML = `<img loading="lazy" decoding="async" src="${field.src}" alt="${altText}" />`;
  } else {
    fieldContentEl.innerHTML = `<p>${field.text}</p>`;
  }
}

// Ny art
function pickRandomCard() {
  if (isRoundMode() && roundTransitioning) return;

  if (isRoundMode() && (!roundPool || roundPool.length === 0)) {
    rebuildRoundPool();
    updateScoreUI();
  }

  const list = getActiveCardList();
  if (!list.length) {
    currentCard = null;
    currentFields = [];
    fieldLabelEl.textContent = "";
    fieldContentEl.innerHTML = "<p>Ingen kort at vise. Tjek evt. filtre.</p>";
    if (familyBadgeEl) familyBadgeEl.textContent = "";
    updateScoreUI();
    return;
  }

  if (isRoundMode()) {
    currentCard = list[0];
  } else {
    const index = Math.floor(Math.random() * list.length);
    currentCard = list[index];
  }

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

  const mode = getBaseGameType();

  if (mode === "husk_feltkendetegn") {
    const fk = getCardValue(currentCard, "Feltkendetegn");
    const text = isNonEmpty(fk) ? String(fk).trim() : "";
    answerTitleEl.textContent = text || "Ingen Feltkendetegn.";

    if (answerFamilyEl) {
      answerFamilyEl.textContent = "";
      answerFamilyEl.classList.add("hidden");
    }

    answerModal.classList.remove("hidden");
    return;
  }

  const title = (currentCard.Title ? String(currentCard.Title).trim() : "") || "Ukendt art";
  answerTitleEl.textContent = title;

  const family = currentCard.Familie ? String(currentCard.Familie).trim() : "";
  if (answerFamilyEl) {
    if (family) {
      answerFamilyEl.textContent = family;
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

// --- Filter panel ---
function isFilterPanelOpen() {
  return filterPanelEl && !filterPanelEl.classList.contains("hidden");
}

function openFilterPanel() {
  closeSearchPanel();
  filterPanelEl.classList.remove("hidden");
  filterToggleBtn.setAttribute("aria-expanded", "true");
}

function closeFilterPanel() {
  filterPanelEl.classList.add("hidden");
  filterToggleBtn.setAttribute("aria-expanded", "false");
}

// --- Search panel ---
function isSearchPanelOpen() {
  return searchPanelEl && !searchPanelEl.classList.contains("hidden");
}

function openSearchPanel() {
  if (!searchPanelEl) return;
  closeFilterPanel();
  searchPanelEl.classList.remove("hidden");
  if (searchToggleBtn) searchToggleBtn.setAttribute("aria-expanded", "true");
  if (searchInputEl && !searchInputEl.disabled) {
    searchInputEl.focus();
    searchInputEl.select();
  }
}

function closeSearchPanel() {
  if (!searchPanelEl) return;
  searchPanelEl.classList.add("hidden");
  if (searchToggleBtn) searchToggleBtn.setAttribute("aria-expanded", "false");
}

// Buttons
if (filterToggleBtn) {
  filterToggleBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (isFilterPanelOpen()) closeFilterPanel();
    else openFilterPanel();
  });
}

if (searchToggleBtn) {
  searchToggleBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (isSearchPanelOpen()) closeSearchPanel();
    else openSearchPanel();
  });
}

// Stop click bubbling inside panels
if (filterPanelEl) filterPanelEl.addEventListener("click", (e) => e.stopPropagation());
if (searchPanelEl) searchPanelEl.addEventListener("click", (e) => e.stopPropagation());

// Click outside closes both
document.addEventListener("click", () => {
  if (isFilterPanelOpen()) closeFilterPanel();
  if (isSearchPanelOpen()) closeSearchPanel();
});

// Filtre change
habitattypeFilterEl.addEventListener("change", onFilterChange);
familieFilterEl.addEventListener("change", onFilterChange);

// ---- Søg: kun Enter/Go udfører søgning ----
function clearSearchState() {
  searchQuery = "";
  if (searchInputEl) searchInputEl.value = "";
}

function runSearchNow() {
  if (isRoundMode()) return;

  const q = (searchQuery || "").trim();
  if (!q) return;

  // søg i filtreret base (så Habitat/Familie kan afgrænse opslagsværket)
  const list = getFilteredBaseList();
  const best = getBestMatchCard(list, q);
  if (!best) return;

  // Byg "normale" felter for aktiv mode (inkl. billeder),
  // men flyt/indsæt Feltkendetegn/Forveksling som første felt
  currentCard = best;

  let fields = buildFieldsForCard(best);
  fields = applySearchPriorityToFields(best, fields);

  // hvis feltkendetegn-mode gav tom (fx ingen Feltkendetegn),
  // så tilføj et hint-billede som i mode (hvis muligt)
  if (getBaseGameType() === "feltkendetegn") {
    fields = ensureHintImageSecond(best, fields);
  }

  if (!fields.length) {
    fields = [{ type: "text", label: "Info", text: "Ingen viste felter for denne art." }];
  }

  currentFields = fields;
  currentFieldIndex = 0;
  updateFamilyBadge();
  renderCurrentField();

  // auto-luk søgningen efter et match
  closeSearchPanel();
  clearSearchState();
}

if (searchInputEl) {
  // disable hvis vi er i round mode ved load
  const round = isRoundMode();
  searchInputEl.disabled = round;
  if (searchToggleBtn) searchToggleBtn.disabled = round;

  // Skrivning må aldrig auto-søge / auto-lukke - den gemmer kun teksten
  searchInputEl.addEventListener("input", () => {
    if (isRoundMode()) return;
    searchQuery = searchInputEl.value || "";
  });

  // Enter/Go = søg
  searchInputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      runSearchNow();
    }
  });
}

if (gameTypeFilterEl) {
  gameTypeFilterEl.addEventListener("change", () => {
    cancelRoundTransition();
    gameType = gameTypeFilterEl.value || "arter";

    // Søg er slået fra i 20-mode
    if (searchInputEl) {
      const round = isRoundMode();
      searchInputEl.disabled = round;
      if (searchToggleBtn) searchToggleBtn.disabled = round;

      if (round) {
        clearSearchState();
        closeSearchPanel();
      }
    }

    if (isRoundMode()) rebuildRoundPool();

    updateScoreUI();
    onFilterChange();
  });
}

clearFiltersBtn.addEventListener("click", () => {
  cancelRoundTransition();

  clearChecked(habitattypeFilterEl);
  clearChecked(familieFilterEl);

  applyFilters();

  if (isRoundMode()) rebuildRoundPool();

  updateScoreUI();
  pickRandomCard();
});

// --- Gestures ---
const thresholdX = 40;
const thresholdY = 70;
const maxSideDrift = 35;

let touchStartX = null;
let touchStartY = null;
let touchStartInBottomZone = false;
let touchStartInTopZone = false;
let gestureCancelled = false;
let touchId = null;

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

  const zonePx = Math.max(90, window.innerHeight * 0.15);

  touchStartInTopZone = touchStartY < zonePx;
  touchStartInBottomZone = touchStartY > (window.innerHeight - zonePx);
}

function onTouchMove(e) {
  if (e.touches.length > 1) {
    gestureCancelled = true;
    return;
  }
  if (gestureCancelled) return;
  if (touchStartX === null || touchStartY === null) return;

  const t =
    Array.from(e.touches).find((tt) => tt.identifier === touchId) ||
    e.touches[0];

  const dx = t.clientX - touchStartX;
  const dy = t.clientY - touchStartY;

  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);

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
    updateScoreUI();
  } catch (err) {
    console.error(err);
    fieldContentEl.innerHTML = "<p>Kunne ikke indlæse data (tjek data/botanik.json).</p>";
  }
}

loadData();
