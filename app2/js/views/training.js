/**
 * training.js — Træningsvisning (flashcards)
 */

export function renderTraining(container, mode) {
  container.innerHTML = `
    <div class="view view-training">
      <header class="topbar">
        <a href="#/" class="topbar-back">← Tilbage</a>
        <h1 class="topbar-title">Træning</h1>
      </header>
      <main><p class="placeholder">Bygges i et senere skridt…</p></main>
    </div>
  `;
}
