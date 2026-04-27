/**
 * home.js — Startskærm med to store knapper: Træning / Opslag
 */

import { getData, getHardSpecies } from "../data.js";


export function renderHome(container) {
  const { arter } = getData();
  const hardCount = getHardSpecies().length;

  container.innerHTML = `
    <div class="home-screen">
      <header class="home-header">
        <h1>Botanik</h1>
        <p class="home-subtitle">Felt-opslag &amp; træning</p>
      </header>

      <main class="home-main">
        <a href="#/lookup" class="big-btn big-btn-lookup">
          <div class="big-btn-icon">🔍</div>
          <div class="big-btn-title">Opslag</div>
          <div class="big-btn-sub">Slå op på navn eller kendetegn</div>
        </a>

        <a href="#/training" class="big-btn big-btn-training">
          <div class="big-btn-icon">📚</div>
          <div class="big-btn-title">Træning</div>
          <div class="big-btn-sub">Flashcards · ${arter.length} arter</div>
        </a>

        ${hardCount > 0 ? `
          <a href="#/training/svaere" class="big-btn big-btn-hard">
            <div class="big-btn-icon">⭐</div>
            <div class="big-btn-title">Træn svære arter</div>
            <div class="big-btn-sub">${hardCount} markeret</div>
          </a>
        ` : ""}
      </main>

      <footer class="home-footer">
        <small>${arter.length} arter · ${countFamilies(arter)} familier</small>
      </footer>
    </div>
  `;
}


function countFamilies(arter) {
  const set = new Set();
  for (const a of arter) {
    if (a.familie) set.add(a.familie);
  }
  return set.size;
}
