"""
find_slugs.py
=============

Interaktivt værktøj til at finde Naturbasen-slug+TaxaID for arter der mangler det.

Strategi:
  1. Læser arter.xlsx (lokal cache med 540 arter)
  2. Læser data/botanik_final.json (dine arter)
  3. For hver art uden slug:
     - Først: fuzzy-match mod arter.xlsx (offline, hurtigt)
     - Hvis ingen god match: live-søg på Naturbasen.dk
     - Vis op til 8 forslag, brugeren vælger med tal eller indtaster manuelt
  4. Opdaterer botanik_final.json løbende

Brug:
    python find_slugs.py
    python find_slugs.py --include-slaegt
    python find_slugs.py --dry-run
    python find_slugs.py --no-live          (kun arter.xlsx, ingen live-søgning)

Kræver:
    pip install openpyxl requests beautifulsoup4
"""

import sys
import json
import argparse
import re
import shutil
from pathlib import Path
from datetime import datetime

import openpyxl
import requests
from bs4 import BeautifulSoup


# Stier
DATA_FILE = Path("../data/botanik_final.json")
ARTER_XLSX = Path("arter.xlsx")
BACKUP_DIR = Path("backup")

# Naturbasen
# Bruger 'at=indeholder' i stedet for 'at=start', så søgningen finder
# arter HVOR SOM HELST i navnet — fx 'Loppe' finder 'Loppe-Star'.
NATURBASEN_SEARCH_URL = "https://www.naturbasen.dk/artsoegning?id={query}&at=indeholder"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) "
                  "Chrome/120.0.0.0 Safari/537.36",
    "Accept-Language": "da-DK,da;q=0.9,en;q=0.8",
}


# =============================================================================
# Normalisering
# =============================================================================

def normalize(s):
    """Normaliser artsnavn til lowercase, simpel form.

    Konverterer også æ/ø/å til ae/oe/aa fordi Naturbasens slugs bruger
    den simplificerede form (fx "billebo-klaseskaerm" for "Billebo-Klaseskærm").
    """
    if not s:
        return ""
    s = str(s).lower().strip()
    s = re.sub(r"\balm\.?\s+", "almindelig ", s)
    s = re.sub(r"\([^)]*\)", "", s)  # fjern (parenteser)
    s = s.replace("-", " ")
    # Konvertér nordiske bogstaver til ascii — så vi matcher slug-format
    s = s.replace("æ", "ae").replace("ø", "oe").replace("å", "aa")
    s = re.sub(r"\s+", " ", s).strip()
    return s


def search_term_for_naturbasen(s):
    """
    Find søge-term til live-søgning på Naturbasen.

    Strategi: Send det MEST DISTINKTIVE ord fra titlen.
    Naturbasen.dk's 'indeholder'-søgning finder arter hvor søgeordet
    forekommer hvor som helst i navnet.

    For "Loppe-Star"          → "Loppe" (mere distinktivt end "Star")
    For "Tue-Kogleaks"        → "Kogleaks" (mere distinktivt end "Tue")
    For "Almindelig Bjørneklo" → "Bjørneklo"
    For "Æblerose"            → "Æblerose"
    For "Billebo-Klaseskærm"  → "Klaseskærm" (mere distinktivt end "Billebo")

    Strategi: Tag det LÆNGSTE ord, da længere ord typisk er mere distinktive.
    Bevar æ/ø/å og første-bogstav-stort.
    """
    if not s:
        return s
    # Behold originale danske tegn — fjern parenteser
    cleaned = re.sub(r"\([^)]*\)", "", str(s)).strip()
    # Fjern "Almindelig" / "Alm."
    cleaned = re.sub(r"\b[Aa]lm\.?\s+", "", cleaned).strip()
    cleaned = re.sub(r"\b[Aa]lmindelig\s+", "", cleaned).strip()

    if not cleaned:
        return s

    # Split på både bindestreg OG mellemrum
    words = re.split(r"[\s\-]+", cleaned)
    words = [w for w in words if w]

    if not words:
        return cleaned

    # Find LÆNGSTE ord (typisk det mest distinktive)
    longest = max(words, key=len)

    # Hvis flere ord har samme længde, foretræk det første
    candidates = [w for w in words if len(w) == len(longest)]
    chosen = candidates[0]

    # Capitalize første bogstav
    return chosen[0].upper() + chosen[1:] if len(chosen) > 1 else chosen.upper()


# =============================================================================
# Levenshtein
# =============================================================================

def levenshtein(a, b):
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
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


def tokens(s):
    return set(normalize(s).split())


def match_score(query, candidate):
    """Beregn similarity 0-100 mellem query og candidate."""
    q = normalize(query)
    c = normalize(candidate)

    if not q or not c:
        return 0

    if q == c:
        return 100

    # Substring
    if q in c:
        return 80 + (15 * len(q) / len(c))
    if c in q:
        return 70 + (15 * len(c) / len(q))

    # Token overlap
    qt = tokens(query)
    ct = tokens(candidate)
    if qt and ct:
        common = qt & ct
        if common:
            jaccard = len(common) / len(qt | ct)
            base = 50 + jaccard * 30
            if qt.issubset(ct):
                base += 10
            # Bonus hvis MEST DISTINKTIVE ord matcher
            longest_q = max(qt, key=len) if qt else ""
            if longest_q in common and len(longest_q) >= 5:
                base += 5
            return min(95, base)

    # Levenshtein
    dist = levenshtein(q, c)
    max_len = max(len(q), len(c))
    if dist <= max_len * 0.3:
        return max(0, 50 - (dist / max_len) * 50)

    return 0


# =============================================================================
# Indlæsning
# =============================================================================

def load_naturbasen_arter(path):
    """Læs arter.xlsx → liste af dicts med name, slug, taxaid."""
    wb = openpyxl.load_workbook(path, data_only=True)
    ws = wb.active
    arter = []
    for row in ws.iter_rows(min_row=2, values_only=True):
        if not row or not row[0]:
            continue
        name, slug, taxaid = row[0], row[1], row[2]
        arter.append({
            "name": str(name).strip(),
            "slug": str(slug).strip() if slug else None,
            "taxaid": str(taxaid).strip() if taxaid else None,
            "source": "xlsx",
        })
    return arter


# =============================================================================
# Live søgning på Naturbasen
# =============================================================================

def naturbasen_live_search(query, timeout=15, verbose=False):
    """Søg på Naturbasen.dk og returner liste af matches."""
    url = NATURBASEN_SEARCH_URL.format(query=query)
    if verbose:
        print(f"     URL: {url}")
    try:
        resp = requests.get(url, headers=HEADERS, timeout=timeout)
        if resp.status_code == 403:
            print(f"  ⚠ Naturbasen afviste forespørgslen (403). Du kan tjekke manuelt:")
            print(f"     {url}")
            return []
        resp.raise_for_status()
    except requests.RequestException as e:
        print(f"  ⚠ Live-søgning fejlede: {e}")
        return []

    soup = BeautifulSoup(resp.text, "html.parser")

    results = []
    seen_taxaids = set()

    for a in soup.find_all("a", href=True):
        href = a["href"]
        m = re.match(r"^/art/(\d+)/([a-z0-9\-]+)$", href)
        if not m:
            continue
        taxaid, slug = m.group(1), m.group(2)
        if taxaid in seen_taxaids:
            continue

        text = a.get_text(separator=" ", strip=True)
        # "Loppe-Star (Carex pulicaris)" → "Loppe-Star"
        danish_name = re.sub(r"\s*\([^)]+\)\s*$", "", text).strip()
        if not danish_name or len(danish_name) > 80:
            continue

        seen_taxaids.add(taxaid)
        results.append({
            "name": danish_name,
            "slug": slug,
            "taxaid": taxaid,
            "source": "naturbasen-live",
        })

    return results


# =============================================================================
# Top matches
# =============================================================================

def find_top_matches(query, naturbasen_arter, top_n=8, min_score=30):
    """Find top_n bedste matches over min_score."""
    scored = []
    for nb_art in naturbasen_arter:
        score = match_score(query, nb_art["name"])
        if score >= min_score:
            scored.append((score, nb_art))
    scored.sort(key=lambda x: -x[0])
    return scored[:top_n]


def merge_and_score(query, *result_lists):
    """Slå flere resultatlister sammen, fjern dubletter, scor og sortér."""
    seen = set()
    merged = []
    for results in result_lists:
        for r in results:
            key = r.get("taxaid") or r.get("slug")
            if key and key not in seen:
                seen.add(key)
                merged.append(r)

    scored = [(match_score(query, r["name"]), r) for r in merged]
    scored.sort(key=lambda x: -x[0])
    return scored


# =============================================================================
# Filter: er det en slægts/gruppe-post?
# =============================================================================

def is_slaegt_or_gruppe(title):
    if not title:
        return False
    lower = title.lower()
    return ("slægt" in lower
            or "(gruppe)" in lower
            or "gruppe)" in lower
            or " og " in lower
            or "vigtigste" in lower
            or "indikerer" in lower)


# =============================================================================
# Fil-håndtering
# =============================================================================

def make_backup(json_path):
    BACKUP_DIR.mkdir(exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    dest = BACKUP_DIR / f"botanik_final_before_findslug_{ts}.json"
    shutil.copy(json_path, dest)
    print(f"  💾 Backup: {dest}")


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


def show_match(idx, score, nb_art, max_name_w):
    name = nb_art["name"].ljust(max_name_w)
    src = "📦" if nb_art.get("source") == "xlsx" else "🌐"
    print(f"  {idx}. {src} {name}  ({nb_art['slug']})  TaxaID: {nb_art['taxaid']}   {score:.0f}")


def confirm_quit():
    a = input("\n  Afslut? Resterende arter springes over. [y/N] ")
    return a.strip().lower() in ("y", "yes", "j", "ja")


# =============================================================================
# Hovedlogik
# =============================================================================

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--include-slaegt", action="store_true",
                        help="Medtag også slægts-poster og grupper")
    parser.add_argument("--dry-run", action="store_true",
                        help="Gem ikke ændringer")
    parser.add_argument("--no-live", action="store_true",
                        help="Skip live Naturbasen-søgning, brug kun arter.xlsx")
    parser.add_argument("--data", type=Path, default=DATA_FILE)
    args = parser.parse_args()

    if not args.data.exists():
        print(f"FEJL: Kan ikke finde {args.data}")
        return 1
    if not ARTER_XLSX.exists():
        print(f"FEJL: Kan ikke finde {ARTER_XLSX}")
        print("       Læg arter.xlsx fra Plantedata-zip-filen i scraper-mappen")
        return 1

    print(f"Læser {args.data}...")
    with open(args.data, "r", encoding="utf-8") as f:
        data = json.load(f)
    print(f"  {len(data)} arter")

    print(f"Læser {ARTER_XLSX}...")
    naturbasen_cache = load_naturbasen_arter(ARTER_XLSX)
    print(f"  {len(naturbasen_cache)} arter i lokal cache")

    if args.no_live:
        print("  (Live-søgning slået fra)")
    else:
        print("  Live-søgning på Naturbasen.dk aktiveret som fallback")

    # Find arter uden slug
    targets = []
    for art in data:
        if not art.get("Naturbasen_Slug"):
            title = art.get("Title", "")
            if not args.include_slaegt and is_slaegt_or_gruppe(title):
                continue
            targets.append(art)

    print_header(f"{len(targets)} arter uden slug")
    if not targets:
        print("Intet at gøre.")
        return 0

    if not args.dry_run:
        make_backup(args.data)

    completed = 0
    skipped = 0
    manual = 0
    quit_early = False

    for i, art in enumerate(targets, 1):
        title = art["Title"]
        print_header(f"[{i}/{len(targets)}]  {title}")
        if art.get("familie") or art.get("Familie"):
            print(f"  Familie: {art.get('familie') or art.get('Familie')}")

        # 1. Først tjek lokal cache
        local_top = find_top_matches(title, naturbasen_cache, top_n=8, min_score=50)

        # Hvis lokal cache har et 100-match, skip live-søgning
        # Ellers altid lav live-søgning også (medmindre --no-live)
        live_top = []
        best_local = local_top[0][0] if local_top else 0
        if best_local < 100 and not args.no_live:
            search_term = search_term_for_naturbasen(title)
            print(f"  🌐 Live-søger på '{search_term}'...")
            live_results = naturbasen_live_search(search_term)
            if live_results:
                live_top = find_top_matches(title, live_results, top_n=8, min_score=30)

        # Slå sammen og prioritér
        all_matches = merge_and_score(title,
                                      [m[1] for m in local_top],
                                      [m[1] for m in live_top])
        all_matches = all_matches[:8]

        if not all_matches or all_matches[0][0] < 30:
            print("\n  ⚠ Ingen gode matches fundet.")
            shown = 0
        else:
            max_w = max(len(m[1]["name"]) for m in all_matches)
            print()
            for idx, (score, nb_art) in enumerate(all_matches, 1):
                show_match(idx, score, nb_art, max_w)
            print(f"\n  📦 = lokal cache    🌐 = live Naturbasen")
            shown = len(all_matches)

        print()
        if shown > 0:
            print(f"  [1-{shown}] Vælg, (s)kip, (m)anuel, (q)uit")
        else:
            print(f"  (s)kip, (m)anuel, (q)uit")

        choice = input("  Valg: ").strip().lower()

        if choice == "q":
            if confirm_quit():
                quit_early = True
                break
            skipped += 1
            continue

        if choice == "s" or choice == "":
            skipped += 1
            print("  → sprunget over")
            continue

        if choice == "m":
            slug = input("  Slug (fx 'almindelig-bjoerneklo'): ").strip()
            taxaid = input("  TaxaID (fx '2858'): ").strip()
            if slug and taxaid:
                art["Naturbasen_Slug"] = slug
                art["Naturbasen_TaxaID"] = taxaid
                manual += 1
                completed += 1
                if not args.dry_run:
                    save_data(args.data, data)
                print(f"  ✓ {title} → {slug} ({taxaid})")
            else:
                print("  → tomt input, sprunget over")
                skipped += 1
            continue

        try:
            n = int(choice)
            if 1 <= n <= shown:
                _, picked = all_matches[n-1]
                art["Naturbasen_Slug"] = picked["slug"]
                art["Naturbasen_TaxaID"] = picked["taxaid"]
                completed += 1
                if not args.dry_run:
                    save_data(args.data, data)
                print(f"  ✓ {title} → {picked['name']} ({picked['slug']})")
            else:
                print(f"  → ugyldigt tal {n}")
                skipped += 1
        except ValueError:
            print(f"  → ukendt input '{choice}'")
            skipped += 1

    if not args.dry_run:
        save_data(args.data, data)
        print(f"\n💾 Gemt til {args.data}")
    else:
        print("\n(--dry-run: ingen ændringer gemt)")

    print_header("Resultat")
    print(f"  Behandlet:     {len(targets)}")
    print(f"  Tilføjet slug: {completed} (heraf {manual} manuelt)")
    print(f"  Sprunget over: {skipped}")
    if quit_early:
        print(f"  Afsluttet før færdig")

    return 0


if __name__ == "__main__":
    sys.exit(main())
