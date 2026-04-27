/**
 * species-detail.js — Detaljevisning af én art
 *
 * Layout:
 *   - Sticky topbar med artsnavn + tilbage-knap
 *   - Billede-galleri (swipe gennem flere)
 *   - Feltkendetegn (mest fremtrædende)
 *   - "Marker som svær"-knap
 *   - Strukturerede tags pænt vist
 *   - Beskrivelse, habitat, forveksling, variation
 */

import {
  findArt,
  getImageUrls,
  isHardSpecies,
  toggleHardSpecies,
} from "../data.js";


export function renderSpeciesDetail(container, title) {
  const art = findArt(title);
  if (!art) {
    container.innerHTML = `
      <div class="view">
        <header class="topbar">
          <a href="javascript:history.back()" class="topbar-back">← Tilbage</a>
          <h1 class="topbar-title">Ikke fundet</h1>
        </header>
        <main><p>Arten "${escapeHtml(title)}" findes ikke i datasættet.</p></main>
      </div>
    `;
    return;
  }

  const imgs = getImageUrls(art);
  const isHard = isHardSpecies(art.Title);
  const tags = art.tags || {};

  container.innerHTML = `
    <div class="view view-detail">
      <header class="topbar topbar-sticky">
        <a href="javascript:history.back()" class="topbar-back">←</a>
        <h1 class="topbar-title">${escapeHtml(art.Title)}</h1>
        <button id="hardToggle" class="hard-toggle ${isHard ? "is-hard" : ""}"
                aria-label="Marker som svær art"
                title="${isHard ? "Fjern fra svære arter" : "Marker som svær art"}">
          ${isHard ? "★" : "☆"}
        </button>
      </header>

      <main class="detail-main">
        ${renderImageGallery(imgs)}

        <section class="detail-meta">
          <div class="detail-tagrow">
            ${art.niveau === "slægt" ? `<span class="badge badge-slaegt">Slægt</span>` : ""}
            ${art.familie ? `<span class="badge">${escapeHtml(art.familie)}</span>` : ""}
            ${art.slægt && art.niveau === "art" ? `<span class="badge badge-light">Slægt: ${escapeHtml(art.slægt)}</span>` : ""}
          </div>
        </section>

        ${renderSection("Feltkendetegn", art.Feltkendetegn, "feltkendetegn")}

        ${renderTagsSection(tags)}

        ${renderSection("Habitat", art.Habitat || art.Naturbasen_Habitat || art.Bog_Habitat)}
        ${renderSection("Beskrivelse", art.Beskrivelser || art.Naturbasen_Kendetegn)}
        ${renderSection("Bog-beskrivelse", art.Bog_Beskrivelse)}
        ${renderSection("Variation", art.Naturbasen_Variation)}
        ${renderSection("Forvekslingsmuligheder", art.Forvekslingsmuligheder || art.Naturbasen_Forvekslingsmuligheder || art.Bog_Forvekslingsmuligheder)}
        ${renderSection("Blomstring", art.samlet_Blomstringstid || art.Naturbasen_blomstring)}
      </main>
    </div>
  `;

  // Bind hard-toggle
  document.getElementById("hardToggle").addEventListener("click", () => {
    const nowHard = toggleHardSpecies(art.Title);
    const btn = document.getElementById("hardToggle");
    btn.textContent = nowHard ? "★" : "☆";
    btn.classList.toggle("is-hard", nowHard);
    btn.title = nowHard ? "Fjern fra svære arter" : "Marker som svær art";
  });

  // Image gallery navigation
  bindGallery();
}


function renderImageGallery(imgs) {
  if (!imgs.length) {
    return `
      <div class="gallery">
        <div class="gallery-empty">Intet billede</div>
      </div>
    `;
  }
  return `
    <div class="gallery" id="gallery">
      <div class="gallery-track" id="galleryTrack">
        ${imgs.map((url, i) => `
          <img src="${url}" alt="" loading="${i === 0 ? "eager" : "lazy"}" />
        `).join("")}
      </div>
      ${imgs.length > 1 ? `
        <div class="gallery-dots" id="galleryDots">
          ${imgs.map((_, i) => `<span class="dot ${i === 0 ? "active" : ""}" data-i="${i}"></span>`).join("")}
        </div>
        <div class="gallery-counter" id="galleryCounter">1 / ${imgs.length}</div>
      ` : ""}
    </div>
  `;
}


function bindGallery() {
  const track = document.getElementById("galleryTrack");
  if (!track) return;
  const counter = document.getElementById("galleryCounter");
  const dots = document.querySelectorAll("#galleryDots .dot");

  track.addEventListener("scroll", () => {
    const i = Math.round(track.scrollLeft / track.clientWidth);
    if (counter) counter.textContent = `${i + 1} / ${track.children.length}`;
    dots.forEach((d, idx) => d.classList.toggle("active", idx === i));
  });

  dots.forEach((d) => {
    d.addEventListener("click", () => {
      const i = parseInt(d.dataset.i);
      track.scrollTo({ left: i * track.clientWidth, behavior: "smooth" });
    });
  });
}


function renderSection(title, text, className = "") {
  if (!text || !String(text).trim()) return "";
  return `
    <section class="detail-section ${className}">
      <h2>${title}</h2>
      <p>${escapeHtml(text).replace(/\n/g, "<br>")}</p>
    </section>
  `;
}


function renderTagsSection(tags) {
  if (!tags || typeof tags !== "object") return "";

  const groups = [
    {
      title: "Vækst",
      fields: ["plantegruppe", "vækstform", "højde", "livscyklus"],
    },
    {
      title: "Stængel & blade",
      fields: ["stængel_form", "stængel_overflade", "stængelmarv",
               "bladstilling", "bladform", "bladrand", "bladtype", "blad_overflade"],
    },
    {
      title: "Blomster & frugt",
      fields: ["blomsterfarve", "blomster_form", "frugttype", "blomstring"],
    },
    {
      title: "Voksested",
      fields: ["habitat", "fugtighed", "næring", "jord", "lys"],
    },
    {
      title: "Andet",
      fields: ["særtræk", "lugt", "anvendelse"],
    },
  ];

  let groupHtml = "";
  for (const g of groups) {
    const items = [];
    for (const f of g.fields) {
      const arr = tags[f];
      if (Array.isArray(arr) && arr.length) {
        items.push(`
          <div class="tag-item">
            <div class="tag-key">${prettyLabel(f)}</div>
            <div class="tag-values">${arr.map(v => `<span class="tag-pill">${escapeHtml(v)}</span>`).join("")}</div>
          </div>
        `);
      }
    }
    if (items.length) {
      groupHtml += `
        <div class="tag-group">
          <h3>${g.title}</h3>
          ${items.join("")}
        </div>
      `;
    }
  }

  // Stikord
  const primary = tags.stikord_primær || [];
  const secondary = tags.stikord_sekundær || [];
  let stikordHtml = "";
  if (primary.length || secondary.length) {
    stikordHtml = `
      <div class="tag-group">
        <h3>Karakteristiske kendetegn</h3>
        ${primary.length ? `
          <ul class="stikord stikord-primary">
            ${primary.map(s => `<li>${escapeHtml(s)}</li>`).join("")}
          </ul>
        ` : ""}
        ${secondary.length ? `
          <details class="stikord-extra">
            <summary>Yderligere kendetegn (${secondary.length})</summary>
            <ul class="stikord stikord-secondary">
              ${secondary.map(s => `<li>${escapeHtml(s)}</li>`).join("")}
            </ul>
          </details>
        ` : ""}
      </div>
    `;
  }

  if (!groupHtml && !stikordHtml) return "";

  return `
    <section class="detail-section detail-tags">
      <h2>Kendetegn</h2>
      ${stikordHtml}
      ${groupHtml}
    </section>
  `;
}


function prettyLabel(key) {
  const map = {
    plantegruppe: "Plantegruppe",
    vækstform: "Vækstform",
    højde: "Højde",
    livscyklus: "Livscyklus",
    stængel_form: "Stængel-form",
    stængel_overflade: "Stængel-overflade",
    stængelmarv: "Stængelmarv",
    bladstilling: "Bladstilling",
    bladform: "Bladform",
    bladrand: "Bladrand",
    bladtype: "Bladtype",
    blad_overflade: "Blad-overflade",
    blomsterfarve: "Blomsterfarve",
    blomster_form: "Blomsterform",
    frugttype: "Frugttype",
    fugtighed: "Fugtighed",
    næring: "Næring",
    jord: "Jord",
    lys: "Lys",
    særtræk: "Særtræk",
    lugt: "Lugt",
    anvendelse: "Anvendelse",
    habitat: "Habitat",
    blomstring: "Blomstring",
  };
  return map[key] || key.replace(/_/g, " ");
}


function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
