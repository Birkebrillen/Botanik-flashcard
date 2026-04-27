/**
 * lookup.js — Opslagsvisning med to undermodes:
 *   - 'name'   → søg på artsnavn (live søgning, fuzzy)
 *   - 'traits' → søg på kendetegn (vægtet hybrid)
 */

import { getData, loadWeights, getImageUrls } from "../data.js";
import {
  searchByName,
  searchByCharacteristics,
  DEFAULT_WEIGHTS,
} from "../search.js";


// State der overlever mellem renders inden for samme session
const state = {
  nameQuery: "",
  traitsQuery: "",
  hardFilters: {
    niveau: null,
    plantegruppe: [],
    familie: [],
    slægt: [],
  },
  softPrefs: {},
};


export function renderLookup(container, mode) {
  if (!mode) mode = "name";

  container.innerHTML = `
    <div class="view view-lookup">
      <header class="topbar topbar-sticky">
        <a href="#/" class="topbar-back">← Tilbage</a>
        <h1 class="topbar-title">Opslag</h1>
      </header>

      <nav class="tabs">
        <a href="#/lookup/name" class="tab ${mode === "name" ? "tab-active" : ""}">
          Artsnavn
        </a>
        <a href="#/lookup/traits" class="tab ${mode === "traits" ? "tab-active" : ""}">
          Kendetegn
        </a>
      </nav>

      <main class="lookup-main" id="lookup-main"></main>
    </div>
  `;

  const main = document.getElementById("lookup-main");
  if (mode === "name") {
    renderNameSearch(main);
  } else {
    renderTraitsSearch(main);
  }
}


// =============================================================================
// MODE 1: Søg på artsnavn
// =============================================================================

function renderNameSearch(container) {
  container.innerHTML = `
    <div class="search-box">
      <input
        id="nameInput"
        type="text"
        placeholder="Skriv artsnavn..."
        autocomplete="off"
        value="${escapeAttr(state.nameQuery)}"
      />
    </div>
    <div id="nameResults" class="results"></div>
  `;

  const input = document.getElementById("nameInput");
  input.addEventListener("input", () => {
    state.nameQuery = input.value;
    runNameSearch();
  });
  input.focus();
  runNameSearch();
}


function runNameSearch() {
  const { arter } = getData();
  const results = searchByName(state.nameQuery, arter, 30);
  const list = document.getElementById("nameResults");

  if (results.length === 0) {
    list.innerHTML = `<p class="empty">Ingen match. Prøv et andet ord.</p>`;
    return;
  }

  list.innerHTML = results.map(art => renderResultRow(art)).join("");
}


// =============================================================================
// MODE 2: Søg på kendetegn
// =============================================================================

function renderTraitsSearch(container) {
  container.innerHTML = `
    <div class="search-box">
      <input
        id="traitsInput"
        type="text"
        placeholder="fx: halvgræs tuedannende mose lille"
        autocomplete="off"
        value="${escapeAttr(state.traitsQuery)}"
      />
    </div>

    <details class="filter-section" id="hardFilterSection">
      <summary>Hårde filtre <span class="hint">(ekskluderer)</span></summary>
      <div class="filter-grid" id="hardFilters"></div>
    </details>

    <details class="filter-section" id="softFilterSection">
      <summary>Vægtede præferencer <span class="hint">(giver bonus)</span></summary>
      <div class="filter-grid" id="softFilters"></div>
    </details>

    <div class="results-header">
      <span id="resultsCount" class="results-count"></span>
      <button id="clearFiltersBtn" class="btn-link">Nulstil filtre</button>
    </div>
    <div id="traitsResults" class="results"></div>
  `;

  buildHardFilters();
  buildSoftFilters();

  const input = document.getElementById("traitsInput");
  input.addEventListener("input", () => {
    state.traitsQuery = input.value;
    runTraitsSearch();
  });

  document.getElementById("clearFiltersBtn").addEventListener("click", () => {
    state.hardFilters = { niveau: null, plantegruppe: [], familie: [], slægt: [] };
    state.softPrefs = {};
    state.traitsQuery = "";
    document.getElementById("traitsInput").value = "";
    buildHardFilters();
    buildSoftFilters();
    runTraitsSearch();
  });

  runTraitsSearch();
}


function buildHardFilters() {
  const { vocabulary } = getData();
  const fields = [
    {
      key: "niveau",
      label: "Niveau",
      options: ["art", "slægt"],
      single: true,
    },
    {
      key: "plantegruppe",
      label: "Plantegruppe",
      options: (vocabulary.plantegruppe || []).map(x => x.value),
    },
    {
      key: "familie",
      label: "Familie",
      options: (vocabulary.familie || []).map(x => x.value).sort(),
    },
    {
      key: "slægt",
      label: "Slægt",
      options: (vocabulary.slægt || []).map(x => x.value).sort(),
    },
  ];

  const container = document.getElementById("hardFilters");
  container.innerHTML = fields.map(f => `
    <div class="filter-group">
      <label for="hard-${f.key}">${f.label}</label>
      <select id="hard-${f.key}">
        <option value="">— alle —</option>
        ${f.options.map(o => {
          const sel = f.single
            ? state.hardFilters[f.key] === o
            : (state.hardFilters[f.key] || []).includes(o);
          return `<option value="${escapeAttr(o)}" ${sel ? "selected" : ""}>${o}</option>`;
        }).join("")}
      </select>
    </div>
  `).join("");

  for (const f of fields) {
    const sel = document.getElementById(`hard-${f.key}`);
    sel.addEventListener("change", () => {
      const val = sel.value;
      if (f.single) {
        state.hardFilters[f.key] = val || null;
      } else {
        state.hardFilters[f.key] = val ? [val] : [];
      }
      runTraitsSearch();
    });
  }
}


function buildSoftFilters() {
  const { vocabulary } = getData();
  const SOFT_FIELDS = [
    "habitat", "blomsterfarve", "vækstform", "frugttype",
    "stængel_form", "fugtighed", "bladform", "lugt", "særtræk", "lys",
  ];

  const fields = SOFT_FIELDS
    .filter(k => vocabulary[k] && vocabulary[k].length)
    .map(k => ({
      key: k,
      label: prettyLabel(k),
      options: vocabulary[k].map(x => x.value).slice(0, 30),
    }));

  const container = document.getElementById("softFilters");
  container.innerHTML = fields.map(f => `
    <div class="filter-group">
      <label for="soft-${f.key}">${f.label}</label>
      <select id="soft-${f.key}">
        <option value="">— ingen præference —</option>
        ${f.options.map(o => {
          const sel = (state.softPrefs[f.key] || []).includes(o);
          return `<option value="${escapeAttr(o)}" ${sel ? "selected" : ""}>${o}</option>`;
        }).join("")}
      </select>
    </div>
  `).join("");

  for (const f of fields) {
    const sel = document.getElementById(`soft-${f.key}`);
    sel.addEventListener("change", () => {
      const val = sel.value;
      if (val) state.softPrefs[f.key] = [val];
      else delete state.softPrefs[f.key];
      runTraitsSearch();
    });
  }
}


function runTraitsSearch() {
  const data = getData();
  const weights = loadWeights(DEFAULT_WEIGHTS);

  const filters = {
    niveau: state.hardFilters.niveau,
    plantegruppe: state.hardFilters.plantegruppe,
    familie: state.hardFilters.familie,
    slægt: state.hardFilters.slægt,
    preferences: state.softPrefs,
  };

  const results = searchByCharacteristics(
    state.traitsQuery,
    filters,
    data.arter,
    data.synonymLookup,
    {
      weights,
      fieldIndex: data.fieldIndex,
      limit: 10,
    }
  );

  const list = document.getElementById("traitsResults");
  const counter = document.getElementById("resultsCount");

  if (results.length === 0) {
    list.innerHTML = `<p class="empty">Ingen arter matcher.</p>`;
    counter.textContent = "0 resultater";
    return;
  }

  counter.textContent = `${results.length} resultat${results.length === 1 ? "" : "er"}`;
  list.innerHTML = results.map(r => renderResultRow(r.art, r)).join("");
}


// =============================================================================
// FÆLLES — render af resultatrække
// =============================================================================

function renderResultRow(art, scored = null) {
  const tags = art.tags || {};
  const niveauBadge = art.niveau === "slægt"
    ? `<span class="badge badge-slaegt">Slægt</span>` : "";

  const summary = buildSummary(tags);

  const imgs = getImageUrls(art);
  const thumb = imgs.length
    ? `<img class="result-thumb" src="${imgs[0]}" alt="" loading="lazy" />`
    : `<div class="result-thumb result-thumb-placeholder">🌿</div>`;

  return `
    <a href="#/art/${encodeURIComponent(art.Title)}" class="result-row">
      ${thumb}
      <div class="result-body">
        <div class="result-title">
          ${niveauBadge}
          ${art.Title}
        </div>
        <div class="result-meta">
          ${art.familie ? `<span>${art.familie}</span>` : ""}
        </div>
        ${summary ? `<div class="result-summary">${summary}</div>` : ""}
      </div>
    </a>
  `;
}


function buildSummary(tags) {
  const parts = [];
  const order = ["plantegruppe", "vækstform", "blomsterfarve", "habitat", "blomstring"];
  for (const k of order) {
    const arr = tags[k] || [];
    if (arr.length) {
      parts.push(arr.slice(0, 3).join(", "));
    }
  }
  return parts.slice(0, 3).join(" · ");
}


// =============================================================================
// HJÆLPERE
// =============================================================================

function escapeAttr(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}


function prettyLabel(key) {
  return key
    .replace(/_/g, " ")
    .replace(/^./, c => c.toUpperCase());
}
