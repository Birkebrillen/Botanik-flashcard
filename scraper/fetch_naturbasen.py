"""
fetch_naturbasen.py
===================

Henter Naturbasen-data (Kendetegn, Variation, Forveksling, blomstring,
Habitat) for arter der har slug men mangler felter i botanik_final.json.

Default: kun udfyld TOMME felter — bevar eksisterende data.
Med --all: overskriv ALT (kør forsigtigt!).

Brug:
    python fetch_naturbasen.py                 (alle arter med tomme felter)
    python fetch_naturbasen.py --all           (overskriv alt for alle med slug)
    python fetch_naturbasen.py --only "Skov-Fyr"   (kun én art)
    python fetch_naturbasen.py --dry-run       (vis kun hvad der ville ske)

Pause: tilfældig mellem 1.5 og 4 sekunder mellem requests for at være
       pæn ved Naturbasen.

Kræver:
    pip install requests beautifulsoup4
"""

import sys
import json
import argparse
import re
import shutil
import time
import random
from pathlib import Path
from datetime import datetime

import requests
from bs4 import BeautifulSoup


# Stier
DATA_FILE = Path("../data/botanik_final.json")
BACKUP_DIR = Path("backup")
LOG_FILE = Path("fetch_naturbasen.log")

# URL
URL_TEMPLATE = "https://www.naturbasen.dk/art/{taxaid}/{slug}"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) "
                  "Chrome/120.0.0.0 Safari/537.36",
    "Accept-Language": "da-DK,da;q=0.9,en;q=0.8",
}

# Mapping: Naturbasen-sektion → vores feltnavn i JSON
SECTION_TO_FIELD = {
    "Kendetegn": "Naturbasen_Kendetegn",
    "Variation": "Naturbasen_Variation",
    "Forveksling": "Naturbasen_Forvekslingsmuligheder",
    "Hvornår ses den": "Naturbasen_blomstring",
    "Levested": "Naturbasen_Habitat",
}

# Indikator for tom sektion på Naturbasen
EMPTY_MARKER = "Tilføj tekst her"

# Pause mellem requests
PAUSE_MIN = 1.5
PAUSE_MAX = 4.0


# =============================================================================
# Scraper
# =============================================================================

def fetch_page(taxaid, slug, timeout=20):
    """Hent HTML fra Naturbasen for én art."""
    url = URL_TEMPLATE.format(taxaid=taxaid, slug=slug)
    resp = requests.get(url, headers=HEADERS, timeout=timeout)
    resp.raise_for_status()
    return resp.text


def parse_naturbasen(html):
    """Udtræk Naturbasen-felterne fra HTML.

    Returnerer dict med Naturbasen_*-felter (kun de der har indhold).
    """
    soup = BeautifulSoup(html, "html.parser")
    result = {}

    for h2 in soup.find_all("h2"):
        section_name = h2.get_text(strip=True).rstrip(":").strip()

        # Find vores felt-mapping
        target_field = None
        for key, field in SECTION_TO_FIELD.items():
            if section_name.startswith(key):
                target_field = field
                break

        if not target_field:
            continue

        # Saml tekst fra alle elementer indtil næste h2
        parts = []
        for sib in h2.find_next_siblings():
            if sib.name == "h2":
                break
            text = sib.get_text(separator=" ", strip=True)
            if not text:
                continue
            text = re.sub(r"^[:\s]+", "", text)
            if text.lower() in ("rediger afsnit", ""):
                continue
            parts.append(text)
            # Stop hvis vi støder på billede-block med 'kort'
            if sib.find("img") and "kort" in sib.get_text().lower():
                break

        full_text = " ".join(parts).strip()
        full_text = re.sub(r"\s*Rediger afsnit\s*", " ", full_text).strip()

        # Tjek om sektionen reelt er tom
        if EMPTY_MARKER in full_text and len(full_text) < 50:
            full_text = ""

        if full_text:
            result[target_field] = full_text

    return result


# =============================================================================
# Filhåndtering
# =============================================================================

def make_backup(json_path):
    BACKUP_DIR.mkdir(exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    dest = BACKUP_DIR / f"botanik_final_before_fetch_{ts}.json"
    shutil.copy(json_path, dest)
    print(f"💾 Backup: {dest}")
    return dest


def save_data(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def log_line(msg):
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(f"{datetime.now().isoformat()}  {msg}\n")


# =============================================================================
# Main
# =============================================================================

def needs_fetching(art, all_fields=False):
    """Skal denne art hentes?"""
    if not art.get("Naturbasen_Slug") or not art.get("Naturbasen_TaxaID"):
        return False
    if all_fields:
        return True
    # Default: hop over hvis Kendetegn allerede er udfyldt OG der er minst
    # ét andet Naturbasen-felt. Det er en pragmatisk regel.
    has_kendetegn = bool(art.get("Naturbasen_Kendetegn"))
    if not has_kendetegn:
        return True
    # Tjek om der mangler felter selvom Kendetegn er der
    for field in SECTION_TO_FIELD.values():
        if not art.get(field):
            return True
    return False


def merge_fields(art, new_data, overwrite=False):
    """Indfletter nye felter i arten. Returnerer antal felter ændret."""
    changed = 0
    for field, value in new_data.items():
        if not value:
            continue
        existing = art.get(field)
        if existing and not overwrite:
            continue  # bevar eksisterende
        if existing != value:
            art[field] = value
            changed += 1
    return changed


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--all", action="store_true",
                        help="Overskriv alle felter (default: kun udfyld tomme)")
    parser.add_argument("--only", help="Kun denne ene art (efter Title)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Vis kun hvad der ville ske, gem ikke")
    parser.add_argument("--data", type=Path, default=DATA_FILE)
    parser.add_argument("--limit", type=int, default=None,
                        help="Maks antal arter (testing)")
    args = parser.parse_args()

    if not args.data.exists():
        print(f"FEJL: Kan ikke finde {args.data}")
        return 1

    with open(args.data, "r", encoding="utf-8") as f:
        data = json.load(f)

    # Find targets
    if args.only:
        targets = [a for a in data if a.get("Title", "").lower() == args.only.lower()]
        if not targets:
            print(f"FEJL: '{args.only}' findes ikke i datasæt")
            return 1
    else:
        targets = [a for a in data if needs_fetching(a, all_fields=args.all)]

    if args.limit:
        targets = targets[:args.limit]

    print(f"\n{'═' * 72}")
    print(f"  Henter Naturbasen-data for {len(targets)} arter")
    print(f"  Mode: {'OVERSKRIV ALT' if args.all else 'kun tomme felter'}")
    print(f"  Pause: {PAUSE_MIN:.1f}-{PAUSE_MAX:.1f} sekunder mellem requests")
    if not targets:
        print(f"\nIngenting at gøre. ✓")
        return 0
    estimated_minutes = (len(targets) * (PAUSE_MIN + PAUSE_MAX) / 2) / 60
    print(f"  Estimeret tid: ~{estimated_minutes:.0f} minutter")
    print(f"{'═' * 72}\n")

    if args.dry_run:
        print("(--dry-run: viser kun hvad der ville ske)\n")
        for art in targets[:20]:
            missing = [f for f in SECTION_TO_FIELD.values() if not art.get(f)]
            print(f"  {art['Title']:35} (mangler: {len(missing)} felter)")
        if len(targets) > 20:
            print(f"  ... og {len(targets) - 20} flere")
        return 0

    if not args.only:
        make_backup(args.data)

    log_line(f"=== START: {len(targets)} targets, mode={'all' if args.all else 'fill-empty'} ===")

    # Stats
    success = 0
    fail = 0
    no_change = 0
    total_fields_added = 0

    start_time = time.time()

    try:
        for i, art in enumerate(targets, 1):
            title = art.get("Title", "?")
            taxaid = art.get("Naturbasen_TaxaID")
            slug = art.get("Naturbasen_Slug")

            # Progress-linje
            elapsed = time.time() - start_time
            avg = elapsed / i if i > 0 else 0
            remaining = (len(targets) - i) * avg
            eta_min = int(remaining / 60)

            line = f"[{i:>3}/{len(targets)}] {title[:35]:35}"

            try:
                html = fetch_page(taxaid, slug)
                fields = parse_naturbasen(html)

                if not fields:
                    print(f"{line}  ⚠ ingen felter fundet ({eta_min} min tilbage)")
                    log_line(f"WARN no-fields {title} ({slug})")
                    fail += 1
                else:
                    changed = merge_fields(art, fields, overwrite=args.all)
                    total_fields_added += changed
                    if changed > 0:
                        save_data(args.data, data)  # løbende save
                        print(f"{line}  ✓ +{changed} felt(er) ({eta_min} min tilbage)")
                        log_line(f"OK +{changed} {title} ({slug})")
                        success += 1
                    else:
                        print(f"{line}  · uændret ({eta_min} min tilbage)")
                        no_change += 1

            except requests.HTTPError as e:
                print(f"{line}  ✗ HTTP-fejl: {e}")
                log_line(f"FAIL HTTP {title} ({slug}): {e}")
                fail += 1
            except requests.RequestException as e:
                print(f"{line}  ✗ Netværk: {e}")
                log_line(f"FAIL NET {title} ({slug}): {e}")
                fail += 1
            except Exception as e:
                print(f"{line}  ✗ Uventet: {e}")
                log_line(f"FAIL OTHER {title} ({slug}): {e}")
                fail += 1

            # Pause — undtagen efter sidste
            if i < len(targets):
                pause = random.uniform(PAUSE_MIN, PAUSE_MAX)
                time.sleep(pause)

    except KeyboardInterrupt:
        print(f"\n\n⚠ Afbrudt af bruger. Gemmer indtil videre...")
        save_data(args.data, data)
        log_line("INTERRUPTED")

    # Final save
    save_data(args.data, data)

    # Summary
    print(f"\n{'═' * 72}")
    print(f"  Færdig.")
    print(f"  ✓ Opdateret:    {success}")
    print(f"  · Uændret:      {no_change}")
    print(f"  ✗ Fejl:         {fail}")
    print(f"  Felter tilføjet: {total_fields_added}")
    print(f"  Tidsforbrug:    {(time.time() - start_time) / 60:.1f} min")
    print(f"  Log:            {LOG_FILE}")
    print(f"{'═' * 72}")

    log_line(f"=== DONE: success={success} no_change={no_change} fail={fail} fields={total_fields_added} ===")
    return 0


if __name__ == "__main__":
    sys.exit(main())
