"""
add_species.py
==============

Tilføj nye arter til botanik_final.json. For hver art:
  1. Fuzzy-søg på Naturbasen (live)
  2. Du bekræfter slug+TaxaID
  3. Stub oprettes med:
       - Title (fra Naturbasen)
       - Familie (fra Naturbasen)
       - Naturbasen_Slug, Naturbasen_TaxaID
       - Feltkendetegn (embedded)
       - niveau="art"

Selve scrapingen af Kendetegn/Habitat osv. sker i fetch_naturbasen.py senere.

Brug:
    python add_species.py                    (interaktiv, alle nye)
    python add_species.py --dry-run          (vis kun, gem ikke)
    python add_species.py --only "Druehyld"  (kun én art)

Kræver:
    pip install requests beautifulsoup4
"""

import sys
import json
import argparse
import re
import shutil
from pathlib import Path
from datetime import datetime

import requests
from bs4 import BeautifulSoup


DATA_FILE = Path("../data/botanik_final.json")
BACKUP_DIR = Path("backup")

NATURBASEN_SEARCH_URL = "https://www.naturbasen.dk/artsoegning?id={query}&at=indeholder"
URL_TEMPLATE = "https://www.naturbasen.dk/art/{taxaid}/{slug}"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) "
                  "Chrome/120.0.0.0 Safari/537.36",
    "Accept-Language": "da-DK,da;q=0.9,en;q=0.8",
}


# =============================================================================
# DE NYE ARTER MED FELTKENDETEGN (embedded)
# =============================================================================

NEW_SPECIES = {
    "Smalbladet vandaks": "Ligner til en start liden vandaks. Blade under 1 mm. brede, ingen klorofylløse bånd langs midternerven og ingen knude ved bladfæstet. Næb på frugten tydeligt > 1/10 af frugtlængden.",
    "Almindelig Ædelgran": "Ligner Nordmannsgran. Brunhårede kviste.",
    "Nordmannsgran": "Ligner alm. ædelgran. Glatte kviste og typisk hvælvede skud.",
    "Grandis": "Olivengrøn barkfarve på indeværende års skud og flade, lange mørkegrønne nåle i meget flade skud på nedre grene. Nåle med lille hak i spidsen og to lysegrønne striber på underside.",
    "Nobilis": "Vinkelbøjede blågrønne nåle og meget store kogler.",
    "Rødgran": "Nåle er kvadratisk-rhombisk i tværsnit og friskgrøn på alle sider.",
    "Hvidgran": "Ligner sitka. Korte nåle, tæt grenbygning og små tillukkede kogler.",
    "Sitkagran": "Stikkende nåle med hvid underside.",
    "Omorikagran": "Karakteristisk smal og næsten søjleformet krone og svungne grene. Mest almindelige nåletræ i haver.",
    "Douglas": "Brune, spidse bøgelignende knopper. Meget bløde nåle, kogler med trefligede dækskæl og korkagtig, tyk skorpebark.",
    "Europæisk lærk": "Løvfældende som alle lærketræer.",
    "Skov-Fyr": "Eneste 2-nålede fyr med blålig nålefarve og især rødlig bark.",
    "Almindelig Bjerg-Fyr": "2-nålede mørkegrønne nåle.",
    "Thuja": "Ligner cypres men med opret topskud.",
    "Ædelcypres": "Hængende C-formet topskud.",
    "Almindelig Ene": "Ingen særlige feltkendetegn — meget karakteristisk slægt.",
    "Taks": "Mangler hak i spidsen og underside matgrøn med to lysegrønne striber.",
    "Platan": "Broget bark med lysegrønne barkpartier og runde karakteristiske frugtstande som hænger langt inde i vinteren. Grønlig bladunderside og opsvulmet fod på stilken.",
    "Småbladet lind": "Hjerteformet blad med glat overside og blågrønlig mat underside. Glat bladstilk. Hobe af rustbrune stjernehår i undersidens nervevinkler. Enkelte tiltrykte brune hår på nerverne.",
    "Parklind": "Glat eller spredt håret bladstilk. Hobe af brune eller lyse stjernehår i nervevinkler.",
    "Sølvpoppel": "Håndlappede blade med tykt filtlag på undersiden der giver karakteristisk hvidligt udseende.",
    "Pyramidepoppel": "Karakteristisk profil med sin høje, smalle krone med talrige næsten lodret opstigende sidegrene. Rudeformede blade.",
    "Landevejspoppel": "Blade med lang spids. Friskgrøn og blanke på overside og matgrøn på underside. Den stynede poppel i landskabet.",
    "Balsampoppel": "Karakteristiske meterlange årsskud på nye træer. Blade ægformet med hjerteformet grund og tilspidsede. Mørkegrøn overside med lyse midt- og sidenerver og hvidgrøn underside.",
    "Tranebær": "Læderagtige under 1 cm aflange små blade. Underside hvidlig og voksdækket.",
    "Mosebølle": "Blade omvendt ægformede og helrandede.",
    "Hunderose": "Blanke blade.",
    "Koralhvidtjørn": "Dybt fligede blade som er savtakkede. Én griffel.",
    "Kristtorn": "Meget karakteristisk.",
    "Vrietorn": "Karakteristisk spids torn i grenvinklen.",
    "Spidsløn": "Frøvinger danner stump vinkel. Blade med skarpe spidser.",
    "Navr": "Lappede blade med butte lapper og korket bark.",
    "Druehyld": "Rødbrun marv. Gulliggrønne blomster og røde frugter.",
}


# =============================================================================
# Søgeord-strategi (samme som find_slugs.py)
# =============================================================================

def search_term_for_naturbasen(s):
    """Find længste, mest distinktive ord til Naturbasen-søgning."""
    if not s:
        return s
    cleaned = re.sub(r"\([^)]*\)", "", str(s)).strip()
    cleaned = re.sub(r"\b[Aa]lm\.?\s+", "", cleaned).strip()
    cleaned = re.sub(r"\b[Aa]lmindelig\s+", "", cleaned).strip()
    if not cleaned:
        return s
    words = re.split(r"[\s\-]+", cleaned)
    words = [w for w in words if w]
    if not words:
        return cleaned
    longest = max(words, key=len)
    return longest[0].upper() + longest[1:] if len(longest) > 1 else longest.upper()


# =============================================================================
# Live-søgning + side-fetch
# =============================================================================

def naturbasen_live_search(query, timeout=15):
    url = NATURBASEN_SEARCH_URL.format(query=query)
    try:
        resp = requests.get(url, headers=HEADERS, timeout=timeout)
        if resp.status_code == 403:
            print(f"  ⚠ 403 fra Naturbasen. Tjek manuelt: {url}")
            return []
        resp.raise_for_status()
    except requests.RequestException as e:
        print(f"  ⚠ Live-søgning fejlede: {e}")
        return []

    soup = BeautifulSoup(resp.text, "html.parser")
    results = []
    seen = set()
    for a in soup.find_all("a", href=True):
        href = a["href"]
        m = re.match(r"^/art/(\d+)/([a-z0-9\-]+)$", href)
        if not m:
            continue
        taxaid, slug = m.group(1), m.group(2)
        if taxaid in seen:
            continue
        text = a.get_text(separator=" ", strip=True)
        danish_name = re.sub(r"\s*\([^)]+\)\s*$", "", text).strip()
        if not danish_name or len(danish_name) > 80:
            continue
        seen.add(taxaid)
        results.append({"name": danish_name, "slug": slug, "taxaid": taxaid})
    return results


def fetch_species_metadata(taxaid, slug, timeout=15):
    """Hent Title (h1) og Familie fra artens side."""
    url = URL_TEMPLATE.format(taxaid=taxaid, slug=slug)
    try:
        resp = requests.get(url, headers=HEADERS, timeout=timeout)
        resp.raise_for_status()
    except requests.RequestException as e:
        return None, None

    soup = BeautifulSoup(resp.text, "html.parser")
    # Title fra h1
    h1 = soup.find("h1")
    title = h1.get_text(strip=True) if h1 else None
    if title:
        title = re.sub(r"\s*Foto:.*$", "", title).strip()

    # Familie — leder efter "Familie:" i sidens metadata
    familie = None
    for li in soup.find_all("li"):
        text = li.get_text(separator=" ", strip=True)
        m = re.search(r"Familie:\s*(.+?)(?:\s*Orden:|$)", text)
        if m:
            familie = m.group(1).strip()
            break

    # Hvis ikke fundet i li, tag fra brødkrumme-stien
    if not familie:
        # Find /familie/{id}/{name}
        for a in soup.find_all("a", href=True):
            m = re.match(r"^/familie/\d+/([a-z\-]+)", a["href"])
            if m:
                familie_slug = m.group(1)
                # Konvertér slug til pænt navn
                familie = " ".join(w.capitalize() for w in familie_slug.replace("-", " ").split())
                break

    return title, familie


# =============================================================================
# Match-score (samme princip som find_slugs)
# =============================================================================

def normalize(s):
    if not s:
        return ""
    s = str(s).lower().strip()
    s = re.sub(r"\balm\.?\s+", "almindelig ", s)
    s = re.sub(r"\([^)]*\)", "", s)
    s = s.replace("-", " ")
    s = s.replace("æ", "ae").replace("ø", "oe").replace("å", "aa")
    s = re.sub(r"\s+", " ", s).strip()
    return s


def levenshtein(a, b):
    if a == b: return 0
    if not a: return len(b)
    if not b: return len(a)
    m, n = len(a), len(b)
    prev = list(range(n + 1))
    curr = [0] * (n + 1)
    for i in range(1, m + 1):
        curr[0] = i
        for j in range(1, n + 1):
            cost = 0 if a[i-1] == b[j-1] else 1
            curr[j] = min(curr[j-1] + 1, prev[j] + 1, prev[j-1] + cost)
        prev, curr = curr, prev
    return prev[n]


def match_score(query, candidate):
    q = normalize(query)
    c = normalize(candidate)
    if not q or not c:
        return 0
    if q == c:
        return 100
    if q in c:
        return 80 + (15 * len(q) / len(c))
    if c in q:
        return 70 + (15 * len(c) / len(q))
    qt = set(q.split())
    ct = set(c.split())
    if qt and ct:
        common = qt & ct
        if common:
            jaccard = len(common) / len(qt | ct)
            base = 50 + jaccard * 30
            if qt.issubset(ct):
                base += 10
            return min(95, base)
    dist = levenshtein(q, c)
    max_len = max(len(q), len(c))
    if dist <= max_len * 0.3:
        return max(0, 50 - (dist / max_len) * 50)
    return 0


# =============================================================================
# Backup
# =============================================================================

def make_backup(json_path):
    BACKUP_DIR.mkdir(exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    dest = BACKUP_DIR / f"botanik_final_before_addspecies_{ts}.json"
    shutil.copy(json_path, dest)
    print(f"💾 Backup: {dest}")


def save_data(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


# =============================================================================
# UI
# =============================================================================

def print_header(text):
    print("\n" + "═" * 72)
    print(text)
    print("═" * 72)


def show_match(idx, score, nb_art, max_w):
    name = nb_art["name"].ljust(max_w)
    print(f"  {idx}. {name}  ({nb_art['slug']})  TaxaID: {nb_art['taxaid']}   {score:.0f}")


# =============================================================================
# Main
# =============================================================================

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true",
                        help="Gem ikke ændringer")
    parser.add_argument("--only", help="Tilføj kun denne ene art (efter navn)")
    parser.add_argument("--data", type=Path, default=DATA_FILE)
    args = parser.parse_args()

    if not args.data.exists():
        print(f"FEJL: Kan ikke finde {args.data}")
        return 1

    with open(args.data, "r", encoding="utf-8") as f:
        data = json.load(f)

    # Eksisterende titler
    existing = {a.get("Title", "").lower().strip() for a in data}

    # Filtrér
    targets = NEW_SPECIES.items()
    if args.only:
        targets = [(k, v) for k, v in NEW_SPECIES.items()
                   if k.lower() == args.only.lower()]
        if not targets:
            print(f"FEJL: '{args.only}' er ikke i den foruddefinerede liste.")
            return 1

    print_header(f"Tilføjer {len(list(targets))} nye arter til {args.data}")
    if not args.dry_run:
        make_backup(args.data)

    targets = list(NEW_SPECIES.items()) if not args.only else \
              [(k, v) for k, v in NEW_SPECIES.items() if k.lower() == args.only.lower()]

    added = 0
    skipped = 0

    for i, (artsnavn, feltkendetegn) in enumerate(targets, 1):
        print_header(f"[{i}/{len(targets)}]  {artsnavn}")

        # Tjek om allerede i datasæt
        if artsnavn.lower().strip() in existing:
            print(f"  ⚠ '{artsnavn}' findes allerede i botanik_final.json — sprunget over")
            skipped += 1
            continue

        # Søg på Naturbasen
        search_term = search_term_for_naturbasen(artsnavn)
        print(f"  🌐 Søger på '{search_term}'...")
        results = naturbasen_live_search(search_term)

        if not results:
            print(f"  Ingen resultater. (s)kip eller (m)anuel?")
            choice = input("  Valg: ").strip().lower()
            if choice == "m":
                slug = input("  Slug: ").strip()
                taxaid = input("  TaxaID: ").strip()
                if slug and taxaid:
                    pass  # behandles nedenfor
                else:
                    skipped += 1
                    continue
            else:
                skipped += 1
                continue
            picked = {"slug": slug, "taxaid": taxaid, "name": artsnavn}
        else:
            # Score og vis top 8
            scored = [(match_score(artsnavn, r["name"]), r) for r in results]
            scored.sort(key=lambda x: -x[0])
            top = scored[:8]

            max_w = max(len(t[1]["name"]) for t in top)
            print()
            for idx, (score, r) in enumerate(top, 1):
                show_match(idx, score, r, max_w)

            print(f"\n  [1-{len(top)}] Vælg, (s)kip, (m)anuel, (q)uit")
            choice = input("  Valg: ").strip().lower()

            if choice == "q":
                print("  Afslutter — gemmer indtil videre")
                break
            if choice == "s" or choice == "":
                print("  → sprunget over")
                skipped += 1
                continue
            if choice == "m":
                slug = input("  Slug: ").strip()
                taxaid = input("  TaxaID: ").strip()
                if not (slug and taxaid):
                    skipped += 1
                    continue
                picked = {"slug": slug, "taxaid": taxaid, "name": artsnavn}
            else:
                try:
                    n = int(choice)
                    if 1 <= n <= len(top):
                        picked = top[n-1][1]
                    else:
                        print(f"  Ugyldigt: {n}")
                        skipped += 1
                        continue
                except ValueError:
                    print(f"  Ukendt input '{choice}'")
                    skipped += 1
                    continue

        # Hent metadata fra Naturbasen-siden
        print(f"  📥 Henter metadata for {picked['slug']}...")
        title, familie = fetch_species_metadata(picked["taxaid"], picked["slug"])
        if not title:
            title = picked.get("name") or artsnavn
        if not familie:
            familie = ""

        # Vis hvad vi tilføjer
        print(f"  ✓ Title:    {title}")
        print(f"    Familie:  {familie}")
        print(f"    Slug:     {picked['slug']}")
        print(f"    TaxaID:   {picked['taxaid']}")
        print(f"    Felt:     {feltkendetegn[:80]}{'...' if len(feltkendetegn) > 80 else ''}")

        # Byg art-objekt
        new_art = {
            "Title": title,
            "niveau": "art",
            "Familie": familie,
            "familie": familie,
            "Naturbasen_Slug": picked["slug"],
            "Naturbasen_TaxaID": picked["taxaid"],
            "Feltkendetegn": feltkendetegn,
        }

        data.append(new_art)
        existing.add(title.lower().strip())
        added += 1

        if not args.dry_run:
            save_data(args.data, data)

    # Final save
    if not args.dry_run:
        save_data(args.data, data)
        print(f"\n💾 Gemt til {args.data}")
    else:
        print("\n(--dry-run: ingen ændringer gemt)")

    print_header("Resultat")
    print(f"  Tilføjet:      {added}")
    print(f"  Sprunget over: {skipped}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
