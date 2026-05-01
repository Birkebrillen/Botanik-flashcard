/**
 * lookup.js — Opslagsvisning med to undermodes:
 *   - 'name'   → søg på artsnavn (live søgning, fuzzy)
 *   - 'traits' → søg på kendetegn (fritekst-felt parser nøgleord som hårde filtre)
 *
 * Ny version: ingen dropdowns. Alt styres af hvad brugeren skriver +
 * en segmenteret kontrol til at skifte mellem Arter og Grupper.
 */

import { getData, loadWeights, getImageUrls } from "../data.js";
import {
  searchByName,
  searchByCharacteristics,
  parseQueryFilters,
  DEFAULT_WEIGHTS,
} from "../search.js";


// State der overlever mellem renders inden for samme session
const state = {
  nameQuery: "",
  traitsQuery: "",
  scope: "arter",  // 'arter' eller 'grupper'
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
// MODE 2: Søg på kendetegn — fritekst med automatiske filtre
// =============================================================================

function renderTraitsSearch(container) {
  container.innerHTML = `
    <div class="scope-toggle" role="tablist" aria-label="Vis arter eller grupper">
      <button type="button"
              class="scope-btn ${state.scope === "arter" ? "scope-btn-active" : ""}"
              data-scope="arter"
              role="tab"
              aria-selected="${state.scope === "arter"}">
        Arter
      </button>
      <button type="button"
              class="scope-btn ${state.scope === "grupper" ? "scope-btn-active" : ""}"
              data-scope="grupper"
              role="tab"
              aria-selected="${state.scope === "grupper"}">
        Kendetegn for grupper
      </button>
    </div>

    <div class="search-box">
      <input
        id="traitsInput"
        type="text"
        placeholder="fx: halvgræs tuedannende mose lille"
        autocomplete="off"
        value="${escapeAttr(state.traitsQuery)}"
      />
    </div>

    <div class="results-header">
      <span id="resultsCount" class="results-count"></span>
      <button id="clearFiltersBtn" class="btn-link">Nulstil</button>
    </div>
    <div id="traitsResults" class="results"></div>
  `;

  const input = document.getElementById("traitsInput");
  input.addEventListener("input", () => {
    state.traitsQuery = input.value;
    runTraitsSearch();
  });

  // Scope-toggle (Arter / Grupper)
  for (const btn of document.querySelectorAll(".scope-btn")) {
    btn.addEventListener("click", () => {
      const newScope = btn.dataset.scope;
      if (newScope !== state.scope) {
        state.scope = newScope;
        // Re-render hele traits-view så knapperne opdateres
        renderTraitsSearch(container);
      }
    });
  }

  document.getElementById("clearFiltersBtn").addEventListener("click", () => {
    state.traitsQuery = "";
    document.getElementById("traitsInput").value = "";
    runTraitsSearch();
  });

  runTraitsSearch();
}


function runTraitsSearch() {
  const data = getData();
  const weights = loadWeights(DEFAULT_WEIGHTS);

  // Filtrér data efter scope (arter vs grupper)
  let scoped;
  if (state.scope === "arter") {
    scoped = data.arter.filter(a => a.niveau === "art");
  } else {
    scoped = data.arter.filter(a =>
      a.niveau === "slægt" || a.niveau === "gruppe"
    );
  }

  // Parse fritekst-feltet til hårde filtre + søgeord
  const parsed = parseQueryFilters(state.traitsQuery, data.vocabulary);

  const filters = {
    plantegruppe: parsed.plantegruppe,
    familie: parsed.familie,
    slægt: parsed.slægt,
    preferences: {},
  };

  const results = searchByCharacteristics(
    parsed.freeText,
    filters,
    scoped,
    data.synonymLookup,
    {
      weights,
      fieldIndex: data.fieldIndex,
      limit: 30,
    }
  );

  // Sortering:
  //  - Hvis ingen søgeord (kun hårde filtre eller helt tomt): alfabetisk
  //  - Hvis søgeord findes: efter score (search.js gør det allerede)
  if (!parsed.freeText.trim()) {
    results.sort((a, b) =>
      (a.art.Title || "").localeCompare(b.art.Title || "", "da")
    );
  }

  const list = document.getElementById("traitsResults");
  const counter = document.getElementById("resultsCount");

  if (results.length === 0) {
    list.innerHTML = `<p class="empty">Ingen ${state.scope === "arter" ? "arter" : "grupper/slægter"} matcher.</p>`;
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

  // Badge for niveau
  let niveauBadge = "";
  if (art.niveau === "slægt") {
    niveauBadge = `<span class="badge badge-slaegt">Slægt</span>`;
  } else if (art.niveau === "gruppe") {
    niveauBadge = `<span class="badge badge-gruppe">Gruppe</span>`;
  }

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
