"""
retag.py
========

Genererer tags for arter i botanik_final.json via Anthropic API.

Mode:
  --mode new         : Kun arter UDEN tags (typisk de 33 nye)
  --mode updated     : Nye + arter med opdaterede Naturbasen-felter (default)
  --mode all-incomplete : Alle arter med manglende eller tomme tags

Bruger Naturbasen_Kendetegn + Habitat + Variation + Forveksling +
Feltkendetegn som input. Returnerer 27 tag-kategorier.

Brug:
    python retag.py                         (mode=updated, default)
    python retag.py --mode new              (kun de nye)
    python retag.py --only "Druehyld"       (en enkelt)
    python retag.py --dry-run               (vis kun, kald ikke API)
    python retag.py --limit 5               (test på 5)

Kræver:
    pip install anthropic
    $env:ANTHROPIC_API_KEY = "sk-ant-..."
"""

import sys
import os
import json
import argparse
import shutil
import time
import random
from pathlib import Path
from datetime import datetime

import anthropic


DATA_FILE = Path("../data/botanik_final.json")
BACKUP_DIR = Path("backup")
LOG_FILE = Path("retag.log")
MODEL = "claude-sonnet-4-5-20250929"
MAX_TOKENS = 2000

# Tilfældig pause mellem requests for ikke at hammer API
PAUSE_MIN = 1.0
PAUSE_MAX = 2.5


# =============================================================================
# Tag-skema og vocabulary
# =============================================================================

VOCABULARY = {
    "plantegruppe": ["urt", "græs", "halvgræs", "vandplante", "vedplante",
                     "siv", "mos", "bregne", "padderok", "lyngagtig", "sumpplante"],
    "vækstform": ["oprets", "tuedannende", "krybende", "udløberdannende",
                  "forgrenet", "rosetplante", "nedliggende", "opstigende",
                  "rodfæstet", "måttedannende", "flydeplante", "bestanddannende",
                  "klatrende", "snoende", "rodslående", "flerstammet", "buskagtig"],
    "højde": ["meget_lille", "lille", "mellem", "stor", "meget_stor"],
    "livscyklus": ["flerårig", "enårig", "overvintrende", "toårig"],
    "stængel_form": ["rund", "trekantet", "firkantet", "kantet", "sammentrykt",
                     "fladtrykt", "furet", "vinget", "trind", "femkantet", "flad"],
    "stængel_overflade": ["glat", "håret", "ru", "hul", "furet", "filtet",
                          "kirtelhåret", "dunhåret", "korthåret", "klæbrig",
                          "stivhåret", "tornet", "hårfri", "blådugget"],
    "stængelmarv": ["hul", "marvfyldt", "kamret", "ubrudt", "sammenhængende"],
    "bladstilling": ["grundstillede", "rosetstillede", "modsat", "kransstillet",
                     "spredt", "stængelomfattende", "toradet", "enkeltvis", "siddende"],
    "bladform": ["linjeformede", "lancetformede", "ægformede", "fjersnitdelt",
                 "hjerteformede", "elliptisk", "ovale", "runde", "flade",
                 "nyreformede", "rendeformet", "håndlappet", "trådformede",
                 "trekantede", "nåleformede", "fliget", "pilformede", "spydformede"],
    "bladrand": ["tandet", "savtakket", "helrandet", "fliget", "dybt-delt",
                 "lappet", "tornet", "skarptakket", "ru", "rundtakket",
                 "grovtakket", "indrullet", "krusede", "fintakket", "bølget"],
    "bladtype": ["enkelt", "sammensat", "fjersnitdelt", "trekoblet", "fjergrenet",
                 "parfinnet", "fingret", "uligefinnet", "håndsnitdelt", "todelt",
                 "gaffeldelt", "håndlappet", "hånddelt"],
    "blad_overflade": ["glat", "håret", "blank", "ru", "kødfuld", "sukkulent",
                       "filtet", "læderagtig", "dunhåret", "kirtelhåret",
                       "korthåret", "klæbrig", "hårfri", "silkehåret",
                       "stivhåret", "kirtelprikkede", "rynkede"],
    "blomsterfarve": ["hvid", "gul", "rosa", "grøn", "rød", "brun", "violet",
                      "lilla", "blå", "rødviolet", "ubetydelige", "gulgrøn",
                      "rødbrun", "blåviolet", "purpur", "rødlig"],
    "blomster_form": ["aks", "top", "kurv", "klase", "skærm", "enkeltsiddende",
                      "hoved", "halvskærm", "småaks", "krans", "kvast", "kolbe",
                      "svikkel", "dobbeltskærm", "rakle", "dusk"],
    "frugttype": ["nød", "kapsel", "bær", "bælg", "spaltefrugt", "skulpe",
                  "småaks", "kogle", "kernefrugt", "stenfrugt", "bælgkapsel",
                  "sporehuse"],
    "fugtighed": ["fugtig", "våd", "tør", "vand", "frisk", "halvfugtig"],
    "næring": ["næringsrig", "næringsfattig"],
    "jord": ["sandet", "kalk", "sur", "tørv", "leret", "humus", "kalkfattig",
             "dyndet", "grus", "stenet", "mager", "veldrænet", "organisk",
             "morbund", "dyndbund", "saltpåvirket"],
    "lys": ["lysåben", "halvskygge", "skygge"],
    "særtræk": ["stedsegrøn", "tvebo", "løvfældende", "tornet", "giftig",
                "spiselig", "mælkesaft", "sambo", "særbo", "enbo",
                "halvparasitisk", "salttolerant", "bestanddannende",
                "insektfangende", "blådugget", "forvedet", "pælerod",
                "fangstblærer", "sukkulent"],
    "lugt": ["aromatisk", "duftende", "krydret", "vellugtende", "stinkende",
             "harsk", "sød", "karakteristisk", "natduftende", "ram",
             "hvidløg", "klor", "bitter", "ildelugtende", "anis", "velduftende"],
    "anvendelse": ["dyrket", "hegn", "park", "have", "skov", "kulturplante",
                   "fodergræs", "plænegræs", "klitplantage", "prydplante",
                   "spiselig", "læhegn"],
    "habitat": ["eng", "mose", "strandeng", "overdrev", "skov", "klit",
                "vejkant", "hede", "sø", "grøft", "skovbryn", "ruderat",
                "vandløb", "mark", "søbred", "kær", "krat", "skrænt", "have",
                "dam", "klippeløb", "tørveeng", "klitlavning", "hedemose",
                "plantage", "park", "eng", "rigkær", "fattigkær"],
    "blomstring": ["jan", "feb", "mar", "apr", "maj", "jun",
                   "jul", "aug", "sep", "okt", "nov", "dec"],
}


# =============================================================================
# Prompt
# =============================================================================

SYSTEM_PROMPT = """Du er en dansk botaniker der genererer strukturerede tags
til en feltbog-database. Du svarer KUN med valid JSON, intet andet.

Du analyserer en plantes beskrivelse og udfylder 27 tag-kategorier.
Brug danske botaniske termer. Brug TOMME LISTER `[]` for kategorier hvor
beskrivelsen ikke giver tilstrækkelig info.

For hver kategori, foretræk værdier fra den medfølgende vocabulary,
men du må gerne tilføje nye værdier hvis arten har specifikke karakteristika
der ikke dækkes af eksisterende.

VIGTIGE REGLER:
- stikord_primær: 2-5 stærke ARTSBESTEMMENDE kendetegn (de mest entydige
  fra Feltkendetegn og Naturbasen_Kendetegn).
- stikord_sekundær: alle andre relevante feltkendetegn fra teksterne.
- højde: kategorier baseret på MAX-højde — meget_lille:<10cm, lille:10-30cm,
  mellem:30-100cm, stor:100-300cm, meget_stor:>300cm.
- højde_cm: returner som dict {"min": int, "max": int} hvor du er rimeligt
  sikker. Hvis ukendt, returner {"min": 0, "max": 0}.
- blomstring: 3-bogstavs månedsforkortelser i lowercase: jan, feb, mar, apr,
  maj, jun, jul, aug, sep, okt, nov, dec.
- habitat: 2-7 specifikke voksesteder (fx "eng", "mose", "klit").
- Brug ALDRIG strenge i kategorier der forventer lister."""


def make_user_prompt(art):
    """Byg prompt med artens data + vocabulary."""
    parts = [f"Plante: {art.get('Title', '?')}"]

    if art.get("Familie"):
        parts.append(f"Familie: {art['Familie']}")
    if art.get("slægt"):
        parts.append(f"Slægt: {art['slægt']}")

    if art.get("Feltkendetegn"):
        parts.append(f"\nFeltkendetegn (fra brugerens egen feltbog — VIGTIGSTE INPUT):\n{art['Feltkendetegn']}")

    if art.get("Naturbasen_Kendetegn"):
        parts.append(f"\nNaturbasen Kendetegn:\n{art['Naturbasen_Kendetegn']}")

    if art.get("Naturbasen_Variation"):
        parts.append(f"\nNaturbasen Variation:\n{art['Naturbasen_Variation']}")

    if art.get("Naturbasen_Forvekslingsmuligheder"):
        parts.append(f"\nNaturbasen Forveksling:\n{art['Naturbasen_Forvekslingsmuligheder']}")

    if art.get("Naturbasen_Habitat"):
        parts.append(f"\nNaturbasen Habitat:\n{art['Naturbasen_Habitat']}")

    if art.get("Naturbasen_blomstring"):
        parts.append(f"\nNaturbasen Blomstring:\n{art['Naturbasen_blomstring']}")

    parts.append("\n=== Vocabulary (foretrukne værdier per kategori) ===")
    for cat, values in VOCABULARY.items():
        parts.append(f"  {cat}: {values}")

    parts.append("""
=== Output ===
Returner KUN JSON med præcis dette skema (ingen markdown-fences, ingen forklaring):

{
  "plantegruppe": [],
  "vækstform": [],
  "højde": [],
  "højde_cm": {"min": 0, "max": 0},
  "livscyklus": [],
  "stængel_form": [],
  "stængel_overflade": [],
  "stængelmarv": [],
  "bladstilling": [],
  "bladform": [],
  "bladrand": [],
  "bladtype": [],
  "blad_overflade": [],
  "blomsterfarve": [],
  "blomster_form": [],
  "frugttype": [],
  "fugtighed": [],
  "næring": [],
  "jord": [],
  "lys": [],
  "særtræk": [],
  "lugt": [],
  "anvendelse": [],
  "habitat": [],
  "blomstring": [],
  "stikord_primær": [],
  "stikord_sekundær": []
}""")

    return "\n".join(parts)


# =============================================================================
# API kald
# =============================================================================

def call_claude(client, art):
    """Kald Claude API for én art. Returner tags-dict eller None ved fejl."""
    user_msg = make_user_prompt(art)

    response = client.messages.create(
        model=MODEL,
        max_tokens=MAX_TOKENS,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_msg}],
    )

    text = response.content[0].text.strip()
    # Strip evt. markdown-fences
    if text.startswith("```"):
        lines = text.split("\n")
        text = "\n".join(l for l in lines if not l.startswith("```"))
    text = text.strip()

    return json.loads(text)


def post_process_tags(tags):
    """Sanitér tags-dict — sørg for korrekt typer."""
    expected_list_keys = [
        "plantegruppe", "vækstform", "højde", "livscyklus",
        "stængel_form", "stængel_overflade", "stængelmarv",
        "bladstilling", "bladform", "bladrand", "bladtype",
        "blad_overflade", "blomsterfarve", "blomster_form",
        "frugttype", "fugtighed", "næring", "jord", "lys",
        "særtræk", "lugt", "anvendelse", "habitat", "blomstring",
        "stikord_primær", "stikord_sekundær",
    ]
    cleaned = {}
    for k in expected_list_keys:
        v = tags.get(k, [])
        if isinstance(v, str):
            v = [v]  # konvertér enkelt-streng til liste
        elif not isinstance(v, list):
            v = []
        cleaned[k] = v

    # højde_cm skal være dict
    h_cm = tags.get("højde_cm", {"min": 0, "max": 0})
    if isinstance(h_cm, dict):
        cleaned["højde_cm"] = {
            "min": int(h_cm.get("min", 0) or 0),
            "max": int(h_cm.get("max", 0) or 0),
        }
    else:
        cleaned["højde_cm"] = {"min": 0, "max": 0}

    return cleaned


# =============================================================================
# Filtrering
# =============================================================================

def needs_retag(art, mode, since_iso=None):
    """Skal denne art re-tagges?"""
    has_tags = bool(art.get("tags"))

    if mode == "new":
        return not has_tags

    if mode == "updated":
        # Nye + dem der har Naturbasen-felter men ingen / inkomplette tags
        if not has_tags:
            return True
        # Hvis Naturbasen_Kendetegn er ny/lang men tags er minimale,
        # tilbyd retag
        tags = art.get("tags", {})
        empty_count = sum(1 for k, v in tags.items()
                          if isinstance(v, list) and len(v) == 0)
        if empty_count >= 18 and art.get("Naturbasen_Kendetegn"):
            return True
        return False

    if mode == "all-incomplete":
        if not has_tags:
            return True
        tags = art.get("tags", {})
        empty_count = sum(1 for k, v in tags.items()
                          if isinstance(v, list) and len(v) == 0)
        return empty_count >= 15

    return False


# =============================================================================
# Backup, save, log
# =============================================================================

def make_backup(json_path):
    BACKUP_DIR.mkdir(exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    dest = BACKUP_DIR / f"botanik_final_before_retag_{ts}.json"
    shutil.copy(json_path, dest)
    print(f"💾 Backup: {dest}")


def save_data(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def log_line(msg):
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(f"{datetime.now().isoformat()}  {msg}\n")


# =============================================================================
# Main
# =============================================================================

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", default="updated",
                        choices=["new", "updated", "all-incomplete"],
                        help="Hvilke arter skal re-tagges")
    parser.add_argument("--only", help="Kun denne ene art (efter Title)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Vis hvad der ville ske, kald ikke API")
    parser.add_argument("--limit", type=int, default=None,
                        help="Maks antal arter (testing)")
    parser.add_argument("--data", type=Path, default=DATA_FILE)
    args = parser.parse_args()

    # API key
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key and not args.dry_run:
        print("FEJL: ANTHROPIC_API_KEY er ikke sat.")
        print('  $env:ANTHROPIC_API_KEY = "sk-ant-..."')
        return 1

    if not args.data.exists():
        print(f"FEJL: Kan ikke finde {args.data}")
        return 1

    with open(args.data, "r", encoding="utf-8") as f:
        data = json.load(f)

    # Find targets
    if args.only:
        targets = [a for a in data
                   if a.get("Title", "").lower() == args.only.lower()]
        if not targets:
            print(f"FEJL: '{args.only}' findes ikke")
            return 1
    else:
        targets = [a for a in data if needs_retag(a, args.mode)]

    if args.limit:
        targets = targets[:args.limit]

    print(f"\n{'═' * 72}")
    print(f"  Re-tagger {len(targets)} arter (mode: {args.mode})")
    print(f"  Model: {MODEL}")
    print(f"  Pause: {PAUSE_MIN:.1f}-{PAUSE_MAX:.1f} sek mellem requests")
    if not targets:
        print(f"\nIngenting at gøre. ✓")
        return 0
    estimated_minutes = (len(targets) * (PAUSE_MIN + PAUSE_MAX) / 2 + len(targets) * 8) / 60
    print(f"  Estimeret tid: ~{estimated_minutes:.0f} minutter")
    print(f"  Estimeret omkostning: ~${len(targets) * 0.03:.2f}")
    print(f"{'═' * 72}\n")

    if args.dry_run:
        print("(--dry-run: viser kun arter, kalder ikke API)\n")
        for art in targets[:30]:
            tags = art.get("tags", {})
            n_empty = sum(1 for v in tags.values()
                          if isinstance(v, list) and len(v) == 0)
            print(f"  {art.get('Title', '?'):40} (tomme felter: {n_empty}/26)")
        if len(targets) > 30:
            print(f"  ... og {len(targets) - 30} flere")
        return 0

    if not args.only:
        make_backup(args.data)

    client = anthropic.Anthropic(api_key=api_key)

    log_line(f"=== START: {len(targets)} targets, mode={args.mode}, model={MODEL} ===")

    success = 0
    fail = 0
    start_time = time.time()

    try:
        for i, art in enumerate(targets, 1):
            title = art.get("Title", "?")
            elapsed = time.time() - start_time
            avg = elapsed / i if i > 0 else 0
            remaining = (len(targets) - i) * avg
            eta_min = int(remaining / 60)

            line = f"[{i:>3}/{len(targets)}] {title[:35]:35}"

            try:
                tags = call_claude(client, art)
                tags = post_process_tags(tags)
                art["tags"] = tags
                save_data(args.data, data)  # løbende save
                print(f"{line}  ✓ ({eta_min} min tilbage)")
                log_line(f"OK {title}")
                success += 1
            except json.JSONDecodeError as e:
                print(f"{line}  ✗ JSON-fejl: {e}")
                log_line(f"FAIL JSON {title}: {e}")
                fail += 1
            except anthropic.APIError as e:
                print(f"{line}  ✗ API-fejl: {e}")
                log_line(f"FAIL API {title}: {e}")
                fail += 1
                # Ved rate-limit, vent længere
                if "rate" in str(e).lower():
                    print(f"  Venter 30 sek...")
                    time.sleep(30)
            except Exception as e:
                print(f"{line}  ✗ Uventet: {e}")
                log_line(f"FAIL OTHER {title}: {e}")
                fail += 1

            if i < len(targets):
                pause = random.uniform(PAUSE_MIN, PAUSE_MAX)
                time.sleep(pause)

    except KeyboardInterrupt:
        print(f"\n\n⚠ Afbrudt. Gemmer indtil videre...")
        save_data(args.data, data)
        log_line("INTERRUPTED")

    save_data(args.data, data)

    print(f"\n{'═' * 72}")
    print(f"  Færdig.")
    print(f"  ✓ Tagged:    {success}")
    print(f"  ✗ Fejl:      {fail}")
    print(f"  Tidsforbrug: {(time.time() - start_time) / 60:.1f} min")
    print(f"  Log:         {LOG_FILE}")
    print(f"{'═' * 72}")

    log_line(f"=== DONE: success={success} fail={fail} ===")
    return 0


if __name__ == "__main__":
    sys.exit(main())
