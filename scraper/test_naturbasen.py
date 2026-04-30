"""
test_naturbasen.py
==================

Tester at Naturbasen-scraperen virker. Henter én art og viser hvad der bliver
udtrukket. Kører IKKE nogen ændringer i botanik_final.json.

Brug:
    python test_naturbasen.py                       (default: aften-pragtstjerne)
    python test_naturbasen.py 3093 aften-pragtstjerne
    python test_naturbasen.py --title "Stjerne-Star"
        (slår op i botanik_final.json og henter slug+TaxaID derfra)

Kræver:
    pip install requests beautifulsoup4
"""

import sys
import json
import argparse
import re
import requests
from bs4 import BeautifulSoup
from pathlib import Path


# Naturbasens URL-mønster
URL_TEMPLATE = "https://www.naturbasen.dk/art/{taxaid}/{slug}"

# User-Agent — vi skal ligne en almindelig browser
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) "
                  "Chrome/120.0.0.0 Safari/537.36",
    "Accept-Language": "da-DK,da;q=0.9,en;q=0.8",
}


# Mapping fra Naturbasen-sektion → vores feltnavn i botanik_final.json
SECTION_TO_FIELD = {
    "Kendetegn": "Naturbasen_Kendetegn",
    "Variation": "Naturbasen_Variation",
    "Forveksling": "Naturbasen_Forvekslingsmuligheder",
    "Hvornår ses den": "Naturbasen_blomstring",
    "Levested": "Naturbasen_Habitat",
}

# Indikator for "tom" sektion på Naturbasen
EMPTY_MARKER = "Tilføj tekst her"


def fetch_page(taxaid, slug):
    """Hent HTML for én art."""
    url = URL_TEMPLATE.format(taxaid=taxaid, slug=slug)
    print(f"→ Henter: {url}")
    resp = requests.get(url, headers=HEADERS, timeout=15)
    resp.raise_for_status()
    print(f"  HTTP {resp.status_code}, {len(resp.content)} bytes")
    return resp.text


def parse_naturbasen(html):
    """Udtræk felter fra Naturbasen HTML.

    Strukturen er:
        <h2>Kendetegn</h2>
        <p><strong>:</strong> tekst tekst tekst</p>
        <p>... mere tekst ...</p>
        <h2>Variation</h2>
        ...

    Returnerer dict med Naturbasen_*-felter.
    """
    soup = BeautifulSoup(html, "html.parser")

    result = {}

    # Find alle h2 og deres efterfølgende indhold
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
            # Spring "Rediger afsnit" og lignende meta over
            text = sib.get_text(separator=" ", strip=True)
            if not text:
                continue
            # Fjern det indledende ":" fra strong-tags
            text = re.sub(r"^[:\s]+", "", text)
            # Spring redigerings-tekst over
            if text.lower() in ("rediger afsnit", ""):
                continue
            parts.append(text)
            # Stop hvis vi støder på et billede-block eller link til kort
            if sib.find("img") and "kort" in sib.get_text().lower():
                break

        full_text = " ".join(parts).strip()

        # Fjern "Rediger afsnit" der nogle gange fanges
        full_text = re.sub(r"\s*Rediger afsnit\s*", " ", full_text).strip()

        # Tjek om sektionen reelt er tom
        if EMPTY_MARKER in full_text and len(full_text) < 50:
            full_text = ""

        if full_text:
            result[target_field] = full_text

    return result


def find_in_botanik(title):
    """Slå en art op i botanik_final.json og returnér slug+TaxaID."""
    paths = [
        Path("data/botanik_final.json"),
        Path("../data/botanik_final.json"),
        Path("/mnt/user-data/uploads/botanik_final.json"),
    ]
    data = None
    for p in paths:
        if p.exists():
            with open(p, "r", encoding="utf-8") as f:
                data = json.load(f)
            print(f"  (læste {p})")
            break
    if data is None:
        print("FEJL: Kunne ikke finde botanik_final.json")
        return None, None

    for art in data:
        if art.get("Title", "").lower() == title.lower():
            return art.get("Naturbasen_TaxaID"), art.get("Naturbasen_Slug")

    # Fuzzy: indeholdes
    for art in data:
        if title.lower() in art.get("Title", "").lower():
            print(f"  (fandt fuzzy: {art['Title']})")
            return art.get("Naturbasen_TaxaID"), art.get("Naturbasen_Slug")

    return None, None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("taxaid", nargs="?", default=None,
                        help="Naturbasen TaxaID (tal)")
    parser.add_argument("slug", nargs="?", default=None,
                        help="Naturbasen slug")
    parser.add_argument("--title", help="Slå op i botanik_final.json via Title")
    parser.add_argument("--show-existing", action="store_true",
                        help="Vis også hvad der allerede står i botanik_final.json")
    args = parser.parse_args()

    if args.title:
        taxaid, slug = find_in_botanik(args.title)
        if not taxaid or not slug:
            print(f"FEJL: '{args.title}' findes ikke i botanik_final.json med slug+TaxaID")
            return 1
    elif args.taxaid and args.slug:
        taxaid, slug = args.taxaid, args.slug
    elif args.taxaid:
        # kun TaxaID — prøv default slug
        print("FEJL: Begge taxaid og slug kræves (eller brug --title)")
        return 1
    else:
        # Default test
        taxaid, slug = "3093", "aften-pragtstjerne"

    print(f"\n=== Tester scraper ===")
    print(f"TaxaID: {taxaid}")
    print(f"Slug:   {slug}\n")

    try:
        html = fetch_page(taxaid, slug)
    except requests.RequestException as e:
        print(f"FEJL ved hentning: {e}")
        return 1

    result = parse_naturbasen(html)

    print("\n=== Udtrukket data ===")
    for field, value in result.items():
        if value:
            preview = value[:300] + ("..." if len(value) > 300 else "")
            print(f"\n{field}:")
            print(f"  {preview}")
        else:
            print(f"\n{field}: (tom)")

    # Vis eksisterende data hvis ønsket
    if args.show_existing and args.title:
        title = args.title
        with open("data/botanik_final.json", "r", encoding="utf-8") as f:
            data = json.load(f)
        for art in data:
            if art.get("Title", "").lower() == title.lower():
                print("\n=== Eksisterende data i botanik_final.json ===")
                for field in SECTION_TO_FIELD.values():
                    v = art.get(field)
                    if v:
                        preview = str(v)[:200] + ("..." if len(str(v)) > 200 else "")
                        print(f"\n{field} (eksisterende):")
                        print(f"  {preview}")

    print("\n=== Done ===")
    return 0


if __name__ == "__main__":
    sys.exit(main())
