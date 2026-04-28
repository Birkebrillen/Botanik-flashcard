/**
 * main.js — App-router og hovedinitialisering
 *
 * Bruger hash-baseret routing:
 *   #/                   → startskærm
 *   #/lookup             → opslag (med to undermodes)
 *   #/lookup/name        → opslag, søg på artsnavn
 *   #/lookup/traits      → opslag, søg på kendetegn
 *   #/art/<title>        → detaljevisning af art
 *   #/training           → træning (forside med spiltyper)
 *   #/training/<type>    → træning aktiv
 */

import { loadData } from "./data.js";
import { renderHome } from "./views/home.js";
import { renderLookup } from "./views/lookup.js";
import { renderSpeciesDetail } from "./views/species-detail.js";
import { renderTraining } from "./views/training.js";


// =============================================================================
// ROUTER
// =============================================================================

const appEl = () => document.getElementById("app");


function parseHash() {
  // "#/lookup/name" → ["lookup", "name"]
  // "#/art/Stjerne-Star" → ["art", "Stjerne-Star"]
  const hash = window.location.hash || "#/";
  const path = hash.replace(/^#\/?/, "");
  if (!path) return [];
  return path.split("/").map(decodeURIComponent);
}


export function navigate(path) {
  if (window.location.hash !== `#/${path}`) {
    window.location.hash = `#/${path}`;
  } else {
    // samme hash — tving render
    handleRouteChange();
  }
}


async function handleRouteChange() {
  const parts = parseHash();
  const root = parts[0] || "";

  // Sørg for data er loaded før vi renderer
  await loadData();

  // Scroll til top når man skifter rute
  window.scrollTo(0, 0);

  // Luk evt. åbne detalje-state
  document.body.classList.remove("on-detail");

  switch (root) {
    case "":
      renderHome(appEl());
      break;

    case "lookup":
      renderLookup(appEl(), parts[1] || null);
      break;

    case "art":
      if (parts[1]) {
        document.body.classList.add("on-detail");
        renderSpeciesDetail(appEl(), parts[1]);
      } else {
        navigate("");
      }
      break;

    case "training":
      renderTraining(appEl(), parts[1] || null);
      break;

    default:
      // Ukendt rute — gå hjem
      navigate("");
  }
}


// =============================================================================
// SERVICE WORKER (offline-funktion)
// =============================================================================

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("./sw.js");
    console.log("[main] Service Worker registreret");
  } catch (err) {
    console.warn("[main] Service Worker fejlede:", err);
  }
}


// =============================================================================
// START
// =============================================================================

window.addEventListener("hashchange", handleRouteChange);

(async () => {
  // Vis loading-besked indtil data er klar
  appEl().innerHTML = '<div class="loading">Indlæser…</div>';

  try {
    await loadData();
  } catch (err) {
    appEl().innerHTML = `
      <div class="error">
        <h2>Fejl</h2>
        <p>Kunne ikke indlæse data. Tjek din internetforbindelse, eller prøv igen.</p>
        <pre>${err && err.message ? err.message : err}</pre>
      </div>
    `;
    return;
  }

  registerServiceWorker();
  handleRouteChange();
})();
