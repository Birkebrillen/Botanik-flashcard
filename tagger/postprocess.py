"""
postprocess.py
==============

Tager botanik_with_tags.json og laver:
1. Normalisering af habitat-værdier (mapper varianter, beholder gode tilføjelser)
2. Mindre konsistens-rettelser (fjerner ugyldige tag-værdier)
3. Genererer søgeindeks pr. art (én flad tekststreng med alt søgbart)
4. Genererer vocabulary.json med alle unikke værdier pr. kategori
5. Genererer synonyms.json (synonymordbog) - et udkast du kan udvide

Output: botanik_final.json + vocabulary.json + synonyms.json

Brug:
    python postprocess.py
"""

import json
from collections import Counter, defaultdict
from pathlib import Path


INPUT = "botanik_with_tags.json"
OUTPUT_DATA = "botanik_final.json"
OUTPUT_VOCAB = "vocabulary.json"
OUTPUT_SYNONYMS = "synonyms.json"


# -------- HABITAT-NORMALISERING --------
# Mapper rå værdier fra LLM-output til kontrolleret-liste-værdier.
# Værdier der ikke er her, beholdes som de er (de er typisk gode specifikke termer
# som "rørsump", "hængesæk" osv.)
HABITAT_MAP = {
    # tydelige varianter
    "gårdsplads": "ruderat",
    "gårdspladser": "ruderat",
    "majsmark": "mark",
    "agerjord": "mark",
    "ager": "mark",
    "agre": "mark",
    "dyrket mark": "mark",
    "marker": "mark",
    "vandhul": "dam",
    "gadekær": "dam",
    "sø og dam": "sø",
    "skove": "skov",
    "skovveje": "skov",
    "skovenge": "eng",
    "vejkanter": "vejkant",
    "ruderater": "ruderat",
    "krats": "krat",
    "havekanter": "have",
    "haver": "have",
    "parker": "park",
    "trampede arealer": "ruderat",
    "trampede steder": "ruderat",
    "moser": "mose",
    "enge": "eng",
    "klitter": "klit",
    "heder": "hede",
    "overdrev og enge": "overdrev",
    "rørskove": "rørsump",
    "vældeng": "vældeng",  # behold
    "vældenge": "vældeng",
    "rørsumpe": "rørsump",
    "tørveenge": "tørveeng",
    "klitlavninger": "klitlavning",
    "skovsumpe": "skovsump",
    "kalkrige enge": "eng",
    "fugtige enge": "eng",
    "tørre enge": "eng",
    "kystskrænter": "kystskrænt",
    "havkyst": "kyst",
    "strand": "strandbred",
    "stranden": "strandbred",
    "kysten": "kyst",
    "diger": "dige",
    "havegærder": "hegn",
    "gærder": "hegn",
    "gærde": "hegn",
    "løvskov": "skov",
    "løvskove": "skov",
    "nåleskov": "skov",
    "nåleskove": "skov",
    "blandet skov": "skov",
    "egekrat": "krat",
    "elkrat": "krat",
    "pilekrat": "krat",
    "buskads": "krat",
    "skovbund": "skov",
    "skovbunden": "skov",
    "skovrydning": "skov",
    "skovkant": "skovbryn",
    "skovkanter": "skovbryn",
    "klitter": "klit",
    "klitheder": "klit",
    "klitsø": "sø",
    "klitsøer": "sø",
    "kratbevoksning": "krat",
    "ferskvand": "sø",  # default
    "vandløb": "vandløb",  # behold
    "vandløb og søer": "vandløb",
    "kanaler": "kanal",
    "grøfter": "grøft",
    "bække": "bæk",
    "kilder": "kilde",
    "hængesæk": "hængesæk",  # behold (specifikt)
    "højmose": "højmose",  # behold
    "rigkær": "rigkær",  # behold
    "fattigkær": "fattigkær",  # behold
    "tørvemose": "tørvemose",
    "tørvemoser": "tørvemose",
    "dæmning": "dige",
    "dæmninger": "dige",
    "strandvold": "strandvold",
    "strandvolde": "strandvold",
    "strandoverdrev": "strandoverdrev",
    "kliteng": "kliteng",
    "kysteng": "strandeng",
    "saltsøer": "strandeng",
    "saltkær": "strandeng",
}


# Værdier i andre felter der skal fjernes (ugyldige værdier modellen skubbede ind)
INVALID_VALUES = {
    "frugttype": {"vingede", "vingede frugter", "helikopter", "vinget"},  # disse er beskrivelser, ikke frugttyper
    "bladrand": {"groft", "fint", "kort", "lang"},  # adverbielle ord
    "stængel_overflade": {"stive hår", "røde pletter", "ugrenet", "grenet"},  # ikke overflade
    "stængelmarv": {"sammentrykt"},  # ikke marv-egenskab
}


# -------- KATEGORIER DER SKAL MED I SØGEINDEKS --------
TAG_FIELDS = [
    "plantegruppe", "vækstform", "højde", "livscyklus",
    "stængel_form", "stængel_overflade", "stængelmarv",
    "bladstilling", "bladform", "bladrand", "bladtype", "blad_overflade",
    "blomsterfarve", "blomster_form", "frugttype",
    "fugtighed", "næring", "jord", "lys",
    "særtræk", "lugt", "anvendelse",
    "habitat", "blomstring",
    "stikord_primær", "stikord_sekundær"
]


# -------- HOVEDFLOW --------

def normalize_habitat(habitats):
    """Normaliser en liste af habitat-værdier."""
    out = []
    seen = set()
    for h in habitats:
        h_clean = h.strip().lower()
        if not h_clean:
            continue
        # Map hvis muligt, ellers behold
        mapped = HABITAT_MAP.get(h_clean, h_clean)
        if mapped not in seen:
            out.append(mapped)
            seen.add(mapped)
    return out


def clean_invalid(field, values):
    """Fjern kendte ugyldige værdier."""
    invalid = INVALID_VALUES.get(field, set())
    return [v for v in values if v.lower() not in {x.lower() for x in invalid}]


def build_search_text(art):
    """Byg én tekststreng med alt søgbart for arten.
    Bruges til fuzzy søgning + match-scoring."""
    parts = []

    # Title, slægt, familie
    if art.get("Title"):
        parts.append(art["Title"])
    if art.get("slægt"):
        parts.append(art["slægt"])
    if art.get("familie"):
        parts.append(art["familie"])

    tags = art.get("tags", {})
    for field in TAG_FIELDS:
        values = tags.get(field, [])
        if values:
            parts.extend(str(v) for v in values)

    # Inkluder også den oprindelige Feltkendetegn (bruges i søgning)
    if art.get("Feltkendetegn"):
        parts.append(art["Feltkendetegn"])

    return " | ".join(parts)


def main():
    if not Path(INPUT).exists():
        print(f"FEJL: Kan ikke finde {INPUT} i denne mappe.")
        return

    with open(INPUT, "r", encoding="utf-8") as f:
        data = json.load(f)

    print(f"Læser {len(data)} arter fra {INPUT}")

    # 1. Normaliser hver art
    cleaned_count = 0
    invalid_removed = 0
    for art in data:
        tags = art.get("tags", {})
        if not tags:
            continue

        # Habitat-normalisering
        if "habitat" in tags and tags["habitat"]:
            old = tags["habitat"]
            new = normalize_habitat(old)
            if new != old:
                cleaned_count += 1
                tags["habitat"] = new

        # Fjern ugyldige værdier
        for field, invalid_set in INVALID_VALUES.items():
            if field in tags and tags[field]:
                old = tags[field]
                new = clean_invalid(field, old)
                if len(new) != len(old):
                    invalid_removed += len(old) - len(new)
                    tags[field] = new

    print(f"Normaliserede habitat-værdier på {cleaned_count} arter")
    print(f"Fjernede {invalid_removed} ugyldige tag-værdier")

    # 2. Byg søgeindeks pr. art
    for art in data:
        art["_search_text"] = build_search_text(art)

    # 3. Byg vocabulary
    vocab = defaultdict(Counter)
    for art in data:
        tags = art.get("tags", {})
        for field in TAG_FIELDS:
            if field in ("stikord_primær", "stikord_sekundær"):
                continue  # disse er fri tekst
            for v in tags.get(field, []):
                vocab[field][v] += 1

    # Tilføj familier og slægter til vocab
    for art in data:
        if art.get("familie"):
            vocab["familie"][art["familie"]] += 1
        if art.get("slægt"):
            vocab["slægt"][art["slægt"]] += 1

    vocab_output = {
        field: [{"value": v, "count": c}
                for v, c in counter.most_common()]
        for field, counter in vocab.items()
    }

    # 4. Skriv output
    with open(OUTPUT_DATA, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"Skrev {OUTPUT_DATA}")

    with open(OUTPUT_VOCAB, "w", encoding="utf-8") as f:
        json.dump(vocab_output, f, ensure_ascii=False, indent=2)
    print(f"Skrev {OUTPUT_VOCAB}")

    # 5. Skriv synonym-skabelon (du kan udvide den manuelt)
    synonyms = {
        # fugtighed
        "våd": ["sumpet", "vandlidende", "drivvåd"],
        "vand": ["vandet", "i vand", "sø", "dam"],
        "fugtig": ["vådt", "vådbund", "fugtbund"],
        "tør": ["tørbund", "udtørret"],
        # størrelse
        "lille": ["lav", "kort"],
        "stor": ["høj"],
        "meget_stor": ["kæmpe", "kæmpestor"],
        # blomsterfarve
        "rosa": ["lyserød", "pink"],
        "lilla": ["lila", "violet", "purpur"],
        # bladform
        "lancetformede": ["lancetformet", "lansetformet"],
        "ægformede": ["ægformet", "ovalt"],
        "linjeformede": ["linjeformet", "smal", "lineær"],
        "hjerteformede": ["hjerteformet"],
        "rendeformet": ["rendeformede", "v-formet"],
        # stængel_form
        "trekantet": ["tre-kantet", "trikant", "trekant"],
        "firkantet": ["fire-kantet", "kvadratisk"],
        "rund": ["cylindrisk", "trind"],
        # særtræk
        "duftende": ["duft", "lugter godt"],
        "aromatisk": ["krydret"],
        "stinkende": ["lugter dårligt", "ubehagelig lugt"],
        "natduftende": ["dufter om aftenen"],
        "tornet": ["torne", "pigget"],
        "tvebo": ["særkønnet"],
        # blad_overflade
        "sukkulent": ["tyk", "kødfuld", "saftig"],
        "kødfuld": ["sukkulent", "tyk"],
        "håret": ["behåret", "lodden", "dunet"],
        "kirtelhåret": ["klæbrig", "klæbende"],
        "klæbrig": ["klistret", "klæbende", "kirtelhåret"],
        # plantegruppe
        "halvgræs": ["halv-græs", "carex", "star"],
        "siv": ["junkus"],
        "vandplante": ["vand-plante", "akvatisk"],
        # vækstform
        "tuedannende": ["tueformet", "i tuer", "tue"],
        "krybende": ["nedliggende", "lav"],
        "udløberdannende": ["udløbere", "med udløbere"],
        "rosetplante": ["rosetformet", "i roset"],
        # habitat
        "mose": ["sumpområde", "kær"],
        "kær": ["mose", "sumpkær"],
        "skov": ["skovområde", "skovbund"],
        "eng": ["græseng", "engareal"],
        "strandeng": ["strand-eng", "saltvandseng"],
        "klit": ["sandklit", "klitområde"],
    }

    with open(OUTPUT_SYNONYMS, "w", encoding="utf-8") as f:
        json.dump(synonyms, f, ensure_ascii=False, indent=2)
    print(f"Skrev {OUTPUT_SYNONYMS}")

    # 6. Resume
    print("\n--- Resume ---")
    print(f"Total arter: {len(data)}")
    print(f"Med tags: {sum(1 for a in data if a.get('tags'))}")
    print(f"Niveau 'art': {sum(1 for a in data if a.get('niveau') == 'art')}")
    print(f"Niveau 'slægt': {sum(1 for a in data if a.get('niveau') == 'slægt')}")
    print(f"Antal familier: {len(vocab['familie'])}")
    print(f"Antal slægter: {len(vocab['slægt'])}")
    print(f"\nFor at se vocabulary, åbn {OUTPUT_VOCAB}")


if __name__ == "__main__":
    main()
