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

// Rækkefølgen: B, C, D, E, F, G, H, I, J, L
const FIELD_ORDER = [
  { key: "Billede", type: "image", label: "Billede 1" },
  { key: "Billede2", type: "image", label: "Billede 2" },
  { key: "Billede3", type: "image", label: "Billede 3" },
  { key: "Billede4", type: "image", label: "Billede 4" },
  { key: "Billede5", type: "image", label: "Billede 5" },
  { key: "Feltkendetegn", type: "text", label: "Feltkendetegn" },
  { key: "Habitat", type: "text", label: "Habitat" },
    { key: "Beskrivelser", type: "text", label: "Beskrivelse" },
  { key: "Forvekslingsmuligheder", type: "text", label: "Forvekslingsmuligheder" }
];

// Del Habitattype op i "små enkeltværdier" som Eng, Mose, Overdrev osv.
function splitHabitattypeValues(ht) {
  if (!ht) return [];
  return String(ht)
    .split(/[;,/]/)      // del ved ; , eller /
    .map((s) => s.trim())
    .filter(Boolean);
}


function getActiveCardList() {
  // Hvis der er et aktivt filter, bruger vi filteredCards,
  // ellers alle cards
  return filteredCards.length ? filteredCards : cards;
}
function updateFamilyBadge() {
  if (!familyBadgeEl) return;
  const fam = currentCard && currentCard.Familie
    ? String(currentCard.Familie).trim()
    : "";
  familyBadgeEl.textContent = fam || "";
}



// Hj�lpefunktion: lav billedfilnavn ud fra JSON-string i Billede-feltet
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

    // Habitattype: split lange værdier op i fx "Eng", "Mose", "Overdrev"
    if (ht) {
      splitHabitattypeValues(ht).forEach((part) => {
        habitattypeSet.add(part);
      });
    }

    // Familie: vi bruger stadig hele familienavnet
    if (fam) familieSet.add(fam);
  });

  // Fyld Habitattype-select
  habitattypeFilterEl.innerHTML = '<option value="">Alle</option>';
  Array.from(habitattypeSet)
    .sort((a, b) => a.localeCompare(b, "da"))
    .forEach((val) => {
      const opt = document.createElement("option");
      opt.value = val;
      opt.textContent = val;
      habitattypeFilterEl.appendChild(opt);
    });

  // Fyld Familie-select
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

    // Habitattype: match hvis den valgte tekst indgår i hele feltet (case-insensitive)
    let matchHt = true;
    if (selectedHabitattype) {
      matchHt =
        ht.toLowerCase().includes(selectedHabitattype.toLowerCase());
    }

    // Familie: stadig præcist match
    let matchFam = true;
    if (selectedFamilie) {
      matchFam = fam === selectedFamilie;
    }

    return matchHt && matchFam;
  });
}

// Når et filter ændres
function onFilterChange() {
  applyFilters();

  const list = getActiveCardList();
  if (!list.length) {
    currentCard = null;
    currentFields = [];
    fieldLabelEl.textContent = "";
    fieldContentEl.innerHTML = "<p>Ingen kort matcher de valgte filtre.</p>";
    return;
  }

  pickRandomCard();
}

// Byg liste over felter, tomme springes over
function buildFieldsForCard(card) {
  const fields = [];

  FIELD_ORDER.forEach((spec) => {
    const rawValue = card[spec.key];

    if (spec.type === "image") {
      const fileName = extractImageFileName(rawValue);
      if (!fileName) return;

      fields.push({
        type: "image",
        label: spec.label,
        src: "images/" + fileName
      });
    } else {
      if (!rawValue || String(rawValue).trim() === "") return;
      fields.push({
        type: "text",
        label: spec.label,
        text: String(rawValue).trim()
      });
    }
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
    fieldContentEl.innerHTML = `<img src="${field.src}" alt="${currentCard.Title || "Billede"}" />`;
  } else {
    fieldContentEl.innerHTML = `<p>${field.text}</p>`;
  }

}

// Ny tilf�ldig art
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



// N�ste/forrige felt (cirkul�rt)
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
  answerTitleEl.textContent = currentCard.Title || "Ukendt art";
  answerModal.classList.remove("hidden");
}

function closeAnswerModal() {
  answerModal.classList.add("hidden");
}

// Klik udenfor boksen lukker overlay
answerModal.addEventListener("click", (event) => {
  if (event.target === answerModal) {
    closeAnswerModal();
  }
});

habitattypeFilterEl.addEventListener("change", onFilterChange);
familieFilterEl.addEventListener("change", onFilterChange);

clearFiltersBtn.addEventListener("click", () => {
  habitattypeFilterEl.value = "";
  familieFilterEl.value = "";
  applyFilters();
  pickRandomCard();
});

if (filterToggleBtn && filterPanelEl) {
  filterToggleBtn.addEventListener("click", () => {
    const isHidden = filterPanelEl.classList.contains("hidden");
    if (isHidden) {
      filterPanelEl.classList.remove("hidden");
    } else {
      filterPanelEl.classList.add("hidden");
    }
  });
}


// Simpel swipe på touch (venstre/højre = felter, op = ny art)
let touchStartX = null;
let touchStartY = null;

cardEl.addEventListener("touchstart", (e) => {
  if (e.touches.length === 1) {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  }
});

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
    if (dx > 0) {
      prevField();
    } else {
      nextField();
    }
  }

  touchStartX = null;
  touchStartY = null;
});

cardEl.addEventListener("click", () => {
  if (!currentCard) {
    pickRandomCard();
  }
});

cardEl.addEventListener("dblclick", () => {
  if (currentCard) {
    openAnswerModal();
  }
});
// Hent data
async function loadData() {
  try {
    const res = await fetch(DATA_URL);
    if (!res.ok) {
      throw new Error("Kunne ikke hente data: " + res.status);
    }
    const json = await res.json();
    cards = Array.isArray(json) ? json : [];

    buildFilterOptions();
    // ingen filtre valgt i starten, så filteredCards er tom => vi bruger alle cards
  } catch (err) {
    console.error(err);
    fieldContentEl.innerHTML = "<p>Kunne ikke indlæse data (tjek data/botanik.json).</p>";
  }
}

loadData();

