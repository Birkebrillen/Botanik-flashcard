"""
update_niveau_to_gruppe.py
==========================

Opdaterer 'niveau' til 'gruppe' for de 9 fælles-poster der ikke er
enkelt-arter eller botaniske slægter.

Brug:
    python update_niveau_to_gruppe.py              (dry-run)
    python update_niveau_to_gruppe.py --apply      (anvend ændringer)
"""

import sys
import json
import argparse
import shutil
from pathlib import Path
from datetime import datetime


DATA_FILE = Path("../data/botanik_final.json")
BACKUP_DIR = Path("backup")

# De 9 poster der skal have niveau="gruppe"
GRUPPE_TITLES = [
    "Almindelig og canadisk gyldenris",
    "Fodervikke Og agervikke",
    "Kongepen Og borst",
    "Grenet Pindsvineknop s. l.",
    "Blærerod (gruppe)",
    "Sumpstrå (gruppe)",
    "Kongepen (gruppe)",
    "Pindsvineknop (gruppe)",
    "Kællingetand (gruppe)",
]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true",
                        help="Anvend ændringerne (default: bare vis)")
    parser.add_argument("--data", type=Path, default=DATA_FILE)
    args = parser.parse_args()

    if not args.data.exists():
        print(f"FEJL: Kan ikke finde {args.data}")
        return 1

    with open(args.data, "r", encoding="utf-8") as f:
        data = json.load(f)

    # Find dem
    targets = []
    not_found = []
    for title in GRUPPE_TITLES:
        found = False
        for art in data:
            if art.get("Title") == title:
                targets.append(art)
                found = True
                break
        if not found:
            not_found.append(title)

    print(f"\nFundet {len(targets)} af {len(GRUPPE_TITLES)} poster:")
    for art in targets:
        old = art.get("niveau", "?")
        print(f"  {art['Title']:50}  ({old} → gruppe)")

    if not_found:
        print(f"\n⚠ IKKE fundet (Title-mismatch?):")
        for title in not_found:
            print(f"  • {title!r}")

    if not args.apply:
        print(f"\n(--apply ikke sat — ingen ændringer gemt)")
        return 0

    # Backup
    BACKUP_DIR.mkdir(exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    dest = BACKUP_DIR / f"botanik_final_before_niveau_{ts}.json"
    shutil.copy(args.data, dest)
    print(f"\n💾 Backup: {dest}")

    # Anvend
    for art in targets:
        art["niveau"] = "gruppe"

    with open(args.data, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    print(f"✓ Opdateret {len(targets)} poster til niveau='gruppe'")
    return 0


if __name__ == "__main__":
    sys.exit(main())
