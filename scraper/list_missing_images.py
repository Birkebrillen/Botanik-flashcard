"""
list_missing_images.py
======================

Lister arter der stadig mangler billeder i image_manifest.json.
Bruger samme normaliserings-logik som fetch_images.py og data.js.

Brug:
    python list_missing_images.py
    python list_missing_images.py --include-slaegt   (medtag også slægter/grupper)
"""

import sys
import json
import argparse
import re
from pathlib import Path

DATA_FILE = Path("../data/botanik_final.json")
MANIFEST_FILE = Path("../data/image_manifest.json")


def normalize_key(s):
    """Match data.js normalizeKey()."""
    if not s:
        return ""
    n = str(s).lower().strip()
    n = re.sub(r"[\s\-_]+", "", n)
    n = n.replace("æ", "ae").replace("ø", "oe").replace("å", "aa")
    return n


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--include-slaegt", action="store_true",
                        help="Medtag også slægts- og gruppe-poster")
    args = parser.parse_args()

    with open(DATA_FILE, "r", encoding="utf-8") as f:
        data = json.load(f)
    with open(MANIFEST_FILE, "r", encoding="utf-8") as f:
        manifest = json.load(f)

    # Byg normaliseret manifest-set
    manifest_norm = set()
    for key, files in manifest.items():
        if files:
            manifest_norm.add(normalize_key(key))

    missing = []
    no_taxa = []
    slaegt_uden = []

    for art in data:
        title = art.get("Title", "")
        if not title:
            continue

        niveau = art.get("niveau", "art")
        is_slaegt_or_gruppe = niveau in ("slægt", "gruppe")

        if is_slaegt_or_gruppe and not args.include_slaegt:
            # Hop over slægter/grupper i default mode
            if normalize_key(title) not in manifest_norm:
                slaegt_uden.append(art)
            continue

        if normalize_key(title) in manifest_norm:
            continue  # har billeder

        if not (art.get("Naturbasen_Slug") and art.get("Naturbasen_TaxaID")):
            no_taxa.append(art)
        else:
            missing.append(art)

    # Print resultat
    print(f"\n{'═' * 60}")
    print(f"  Arter UDEN billeder")
    print(f"{'═' * 60}\n")

    if missing:
        print(f"  Med slug+TaxaID (kan downloades): {len(missing)}")
        for art in missing:
            niv = art.get("niveau", "?")
            print(f"    • {art['Title']:40} ({niv})")
    else:
        print(f"  ✓ Ingen 'art'-poster mangler billeder!")

    if no_taxa:
        print(f"\n  Uden slug/TaxaID (kan IKKE downloades): {len(no_taxa)}")
        for art in no_taxa[:30]:
            print(f"    • {art['Title']}")
        if len(no_taxa) > 30:
            print(f"    ... og {len(no_taxa) - 30} flere")

    if not args.include_slaegt and slaegt_uden:
        print(f"\n  Slægter/grupper uden billeder (skjult): {len(slaegt_uden)}")
        print(f"  (kør med --include-slaegt for at se dem)")

    print(f"\n{'═' * 60}")
    print(f"  Total mangler:")
    print(f"    arter:           {len(missing)}")
    print(f"    uden slug:       {len(no_taxa)}")
    if args.include_slaegt:
        print(f"    slægter/grupper: {len(slaegt_uden)}")
    print(f"{'═' * 60}")


if __name__ == "__main__":
    main()
