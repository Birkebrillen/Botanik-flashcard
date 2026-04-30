"""
apply_feltkendetegn.py
======================

Læser en tekstfil med Feltkendetegn-indførsler og indsætter dem i
botanik_final.json.

Format på tekstfilen:
    Artsnavn: tekst der beskriver feltkendetegn

    Næste artsnavn: ny tekst...

Mellem hver indførsel: tom linje (men ikke krævet — scriptet håndterer
også linjer uden tom adskillelse, så længe formatet er "Navn: tekst").

Default-adfærd:
    - Hvis arten har TOM Feltkendetegn: indsæt teksten
    - Hvis arten ALLEREDE har Feltkendetegn: log og spring over
    - Hvis arten ikke findes: log og spring over

Med --overwrite: overskriver eksisterende Feltkendetegn

Brug:
    python apply_feltkendetegn.py feltkendetegn_input.txt
    python apply_feltkendetegn.py feltkendetegn_input.txt --overwrite

Workflow:
    1. Scriptet viser hvor mange der ville blive opdateret/sprunget over/ikke fundet
    2. Du bekræfter med y/n
    3. Scriptet anvender ændringerne (med backup først)
    4. Logger gemmes i apply_feltkendetegn.log
"""

import sys
import json
import argparse
import re
import shutil
from pathlib import Path
from datetime import datetime


DATA_FILE = Path("../data/botanik_final.json")
BACKUP_DIR = Path("backup")
LOG_FILE = Path("apply_feltkendetegn.log")


# =============================================================================
# Parse input-fil
# =============================================================================

def parse_input_file(path):
    """Læs tekstfil og returner liste af (artsnavn, tekst)-tuples.

    Format: "Artsnavn: tekst" — accepterer linjer der spænder flere
    fysiske linjer hvis der er tomme linjer mellem dem indtil næste
    "Navn: tekst"-linje.
    """
    with open(path, "r", encoding="utf-8") as f:
        raw = f.read()

    entries = []
    current_name = None
    current_lines = []

    for line in raw.split("\n"):
        # Match "Artsnavn: tekst" — første kolon på linjen er separator
        # Artsnavnet skal starte med stort bogstav eller dansk specialtegn
        m = re.match(r"^([A-ZÆØÅ][^:\n]{0,100}?):\s*(.*)$", line)
        if m:
            # Gem den foregående entry
            if current_name is not None:
                text = " ".join(current_lines).strip()
                if text:
                    entries.append((current_name, text))
            current_name = m.group(1).strip()
            first_text = m.group(2).strip()
            current_lines = [first_text] if first_text else []
        elif current_name is not None:
            # Fortsættelse af forrige tekst
            stripped = line.strip()
            if stripped:
                current_lines.append(stripped)

    # Sidste entry
    if current_name is not None:
        text = " ".join(current_lines).strip()
        if text:
            entries.append((current_name, text))

    return entries


# =============================================================================
# Fuzzy match af artsnavn
# =============================================================================

def normalize_for_match(s):
    """Normaliser artsnavn for case/space/hyphen-insensitiv sammenligning."""
    if not s:
        return ""
    s = str(s).lower().strip()
    # Fjern parentes-indhold
    s = re.sub(r"\([^)]*\)", "", s)
    # Standardisér Alm. → Almindelig
    s = re.sub(r"\balm\.?\s+", "almindelig ", s)
    # Bindestreg og mellemrum behandles ens
    s = re.sub(r"[\s\-]+", " ", s)
    return s.strip()


def normalize_ascii(s):
    """Som normalize_for_match, men også konverterer æ/ø/å → ae/oe/aa."""
    s = normalize_for_match(s)
    s = s.replace("æ", "ae").replace("ø", "oe").replace("å", "aa")
    return s


def split_camel_case(s):
    """Split CamelCase: 'HvidPil' → 'Hvid Pil', 'BåndPil' → 'Bånd Pil'.

    Bevarer originale tegn — splitter kun ved store bogstaver der
    følger små bogstaver eller danske specialtegn.
    """
    if not s:
        return s
    # Indsæt mellemrum før hver "stort bogstav efter et lille bogstav"
    result = re.sub(r"(?<=[a-zæøå])(?=[A-ZÆØÅ])", " ", s)
    return result


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


def suggest_arter(query, data, top_n=8):
    """Find top_n bedste fuzzy-matches for et artsnavn.

    Returner liste af (score, art) sorteret efter relevans.
    """
    norm_q = normalize_ascii(query)
    norm_q_concat = norm_q.replace(" ", "")

    scored = []
    for art in data:
        title = art.get("Title", "")
        if not title:
            continue
        norm_t = normalize_ascii(title)
        norm_t_concat = norm_t.replace(" ", "")

        # Beregn forskellige scores og tag den bedste
        best = 0

        # Substring-bonus: hvis et helt ord fra query er i title
        q_words = set(norm_q.split())
        t_words = set(norm_t.split())
        common = q_words & t_words
        if common:
            # Jaccard + bonus pr fælles ord
            jaccard = len(common) / len(q_words | t_words)
            longest_common = max(common, key=len) if common else ""
            score = 50 + jaccard * 30 + min(15, len(longest_common))
            best = max(best, score)

        # Concat-similarity (uden mellemrum)
        if len(norm_q_concat) >= 3 and len(norm_t_concat) >= 3:
            dist = levenshtein(norm_q_concat, norm_t_concat)
            max_len = max(len(norm_q_concat), len(norm_t_concat))
            sim = max(0, 100 - (dist / max_len) * 100)
            best = max(best, sim * 0.85)

            # Substring bonus
            if norm_q_concat in norm_t_concat:
                best = max(best, 75 + (15 * len(norm_q_concat) / len(norm_t_concat)))
            elif norm_t_concat in norm_q_concat:
                best = max(best, 70 + (15 * len(norm_t_concat) / len(norm_q_concat)))

        if best >= 30:
            scored.append((best, art))

    scored.sort(key=lambda x: -x[0])
    return scored[:top_n]


def find_art(query, data):
    """Find arten i data der matcher query.

    Returner (art_obj, match_type, alternatives).
    match_type:
        'exact'         — Title matcher præcist (case/space/hyphen-insensitiv)
        'ascii'         — Match efter ascii-konvertering af æ/ø/å
        'camel_split'   — Match efter at have splittet CamelCase
        'concat'        — Title-uden-mellemrum matcher query-uden-mellemrum
                          (håndterer 'Gråpil' → 'Grå-Pil')
        'partial'       — Query-ord er substring af unik Title
        None            — ingen match (alternatives kan indeholde forslag)
    """
    # Prøv også med splittet CamelCase
    query_split = split_camel_case(query)
    candidates_query = [query, query_split] if query != query_split else [query]

    # Forsøg 1: exact match (case/hyphen/space-insensitiv)
    for q in candidates_query:
        norm_q = normalize_for_match(q)
        for art in data:
            title = art.get("Title", "")
            if normalize_for_match(title) == norm_q:
                match_type = "camel_split" if q != query else "exact"
                return art, match_type, []

    # Forsøg 2: ascii match (æ/ø/å vs ae/oe/aa)
    for q in candidates_query:
        norm_q_ascii = normalize_ascii(q)
        for art in data:
            title = art.get("Title", "")
            if normalize_ascii(title) == norm_q_ascii:
                return art, "ascii", []

    # Forsøg 3: concat match — fjern alle mellemrum/bindestreger
    # ('Gråpil' matcher 'Grå-Pil')
    norm_query_concat = re.sub(r"\s+", "", normalize_for_match(query))
    norm_query_concat_ascii = re.sub(r"\s+", "", normalize_ascii(query))
    for art in data:
        title = art.get("Title", "")
        norm_t_concat = re.sub(r"\s+", "", normalize_for_match(title))
        norm_t_concat_ascii = re.sub(r"\s+", "", normalize_ascii(title))
        if (norm_t_concat == norm_query_concat
            or norm_t_concat_ascii == norm_query_concat_ascii):
            return art, "concat", []

    # Forsøg 4: partial — query er substring af én unik Title
    norm_query = normalize_for_match(query_split)
    norm_query_ascii = normalize_ascii(query_split)
    partial_matches = []
    for art in data:
        title = art.get("Title", "")
        norm_t = normalize_for_match(title)
        norm_t_ascii = normalize_ascii(title)
        # Tjek om query-ord er delmængde af title-ord
        query_words = set(norm_query.split())
        title_words = set(norm_t.split())
        title_words_ascii = set(norm_t_ascii.split())
        if query_words and (
            query_words.issubset(title_words)
            or query_words.issubset(title_words_ascii)
        ):
            partial_matches.append(art)

    if len(partial_matches) == 1:
        return partial_matches[0], "partial", []
    elif len(partial_matches) > 1:
        # Tvetydigt — returner alternativerne
        return None, None, [a.get("Title", "?") for a in partial_matches]

    return None, None, []


# =============================================================================
# Backup, save, log
# =============================================================================

def make_backup(json_path):
    BACKUP_DIR.mkdir(exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    dest = BACKUP_DIR / f"botanik_final_before_feltkendetegn_{ts}.json"
    shutil.copy(json_path, dest)
    return dest


def save_data(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def log_init():
    """Start ny log-session."""
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(f"\n{'=' * 60}\n")
        f.write(f"Session: {datetime.now().isoformat()}\n")
        f.write(f"{'=' * 60}\n")


def log_line(msg):
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(f"{datetime.now().strftime('%H:%M:%S')}  {msg}\n")


# =============================================================================
# Main
# =============================================================================

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input_file", type=Path,
                        help="Sti til tekstfil med 'Artsnavn: tekst'-linjer")
    parser.add_argument("--overwrite", action="store_true",
                        help="Overskriv eksisterende Feltkendetegn (uden at spørge)")
    parser.add_argument("--review", action="store_true",
                        help="Gennemgå arter med eksisterende Feltkendetegn interaktivt: "
                             "vælg behold/overskriv/sammenskriv for hver")
    parser.add_argument("--data", type=Path, default=DATA_FILE,
                        help=f"Sti til botanik_final.json (default {DATA_FILE})")
    parser.add_argument("--yes", action="store_true",
                        help="Spring bekræftelses-prompt over (kun til scripting)")
    args = parser.parse_args()

    # Tjek filer
    if not args.input_file.exists():
        print(f"FEJL: Kan ikke finde {args.input_file}")
        return 1
    if not args.data.exists():
        print(f"FEJL: Kan ikke finde {args.data}")
        return 1

    # Parse input
    print(f"Læser {args.input_file}...")
    entries = parse_input_file(args.input_file)
    print(f"  Fandt {len(entries)} indførsler")

    # Indlæs data
    print(f"Læser {args.data}...")
    with open(args.data, "r", encoding="utf-8") as f:
        data = json.load(f)
    print(f"  {len(data)} arter")

    # === Forhåndsvisning: kategoriser alle entries ===
    will_update = []      # (entry, art) — tom Feltkendetegn, vil opdatere
    will_overwrite = []   # (entry, art) — har Feltkendetegn, vil overskrive (kun med --overwrite)
    will_skip = []        # (entry, art, eksisterende) — har data, springer over
    not_found = []        # (entry,) — kunne ikke finde i datasæt
    ambiguous = []        # (entry, alternatives) — flere mulige matches

    for name, text in entries:
        art, match_type, alternatives = find_art(name, data)
        if art is None:
            if alternatives:
                ambiguous.append((name, text, alternatives))
            else:
                not_found.append((name, text))
            continue

        existing = art.get("Feltkendetegn", "")
        if existing and not args.overwrite:
            will_skip.append((name, text, art, existing))
        elif existing and args.overwrite:
            will_overwrite.append((name, text, art, existing))
        else:
            will_update.append((name, text, art, match_type))

    # === Interaktiv afklaring for tvetydige + ikke-fundne ===
    resolved_extra = []  # (orig_name, text, art, match_type)
    if (ambiguous or not_found) and not args.yes:
        if ambiguous:
            print(f"\n{'─' * 72}")
            print(f"  Afklaring af tvetydige navne")
            print(f"{'─' * 72}")
            for name, text, alternatives in list(ambiguous):
                print(f"\n  '{name}' kunne være:")
                for i, alt in enumerate(alternatives, 1):
                    print(f"    {i}. {alt}")
                print(f"    s. spring over")
                choice = input(f"  Vælg [1-{len(alternatives)}/s]: ").strip().lower()
                if choice == "s" or choice == "":
                    continue
                try:
                    n = int(choice)
                    if 1 <= n <= len(alternatives):
                        chosen_title = alternatives[n - 1]
                        # Find arten i data
                        for art in data:
                            if art.get("Title") == chosen_title:
                                existing = art.get("Feltkendetegn", "")
                                if existing and not args.overwrite:
                                    will_skip.append((name, text, art, existing))
                                elif existing and args.overwrite:
                                    will_overwrite.append((name, text, art, existing))
                                else:
                                    resolved_extra.append((name, text, art, "manual"))
                                # Fjern fra ambiguous
                                ambiguous = [a for a in ambiguous if a[0] != name]
                                break
                except ValueError:
                    pass

        if not_found:
            print(f"\n{'─' * 72}")
            print(f"  Afklaring af ikke-fundne navne")
            print(f"{'─' * 72}")
            for name, text in list(not_found):
                print(f"\n  '{name}' — ikke fundet automatisk.")
                preview = text[:80] + "..." if len(text) > 80 else text
                print(f"  Tekst: {preview}")

                # Find fuzzy-forslag
                suggestions = suggest_arter(name, data, top_n=8)
                if suggestions:
                    print(f"\n  Mente du:")
                    for i, (score, art) in enumerate(suggestions, 1):
                        title = art.get("Title", "?")
                        print(f"    {i}. {title}   ({score:.0f})")
                    print(f"    s. spring over")
                    print(f"    m. indtast Title manuelt")
                    choice = input(f"  Vælg [1-{len(suggestions)}/s/m]: ").strip().lower()
                else:
                    print(f"  Ingen lignende arter fundet.")
                    print(f"    s. spring over")
                    print(f"    m. indtast Title manuelt")
                    choice = input(f"  Vælg [s/m]: ").strip().lower()

                art_found = None
                if choice == "" or choice == "s":
                    continue
                elif choice == "m":
                    manual = input(f"  Indtast eksakt Title: ").strip()
                    if not manual:
                        continue
                    for art in data:
                        if art.get("Title") == manual:
                            art_found = art
                            break
                    if not art_found:
                        # Prøv også fuzzy
                        art_found, mt, _ = find_art(manual, data)
                        if art_found:
                            confirm = input(f"  → '{art_found.get('Title')}'  bekræft [y/n]: ").strip().lower()
                            if confirm not in ("y", "yes", "j", "ja"):
                                art_found = None
                else:
                    try:
                        n = int(choice)
                        if 1 <= n <= len(suggestions):
                            art_found = suggestions[n - 1][1]
                    except ValueError:
                        pass

                if art_found:
                    existing = art_found.get("Feltkendetegn", "")
                    if existing and not args.overwrite:
                        will_skip.append((name, text, art_found, existing))
                    elif existing and args.overwrite:
                        will_overwrite.append((name, text, art_found, existing))
                    else:
                        resolved_extra.append((name, text, art_found, "manual"))
                    not_found = [n for n in not_found if n[0] != name]
                else:
                    print(f"  → ikke fundet, sprunget over")

    # Tilføj de manuelt afklarede til will_update
    will_update.extend(resolved_extra)

    # === Review-mode: gennemgå arter med eksisterende Feltkendetegn ===
    if args.review and will_skip and not args.yes:
        print(f"\n{'─' * 72}")
        print(f"  Gennemgang af arter med eksisterende Feltkendetegn ({len(will_skip)})")
        print(f"{'─' * 72}")
        print(f"  For hver art kan du vælge:")
        print(f"    k = behold eksisterende (default)")
        print(f"    o = overskriv med ny tekst")
        print(f"    s = skriv en sammenskrivning manuelt")
        print(f"    q = afslut review (resten beholder eksisterende)")
        print()

        new_skip = []
        review_overwrite = []  # (name, new_text, art, old_text)
        review_custom = []     # (name, custom_text, art, old_text)

        try:
            for i, (name, text, art, existing) in enumerate(will_skip, 1):
                title = art.get("Title", name)
                print(f"\n{'═' * 72}")
                print(f"  [{i}/{len(will_skip)}] {title}")
                print(f"{'═' * 72}")
                print(f"\n  EKSISTERENDE i botanik_final.json:")
                print(f"  {existing}")
                print(f"\n  NY tekst fra input-fil:")
                print(f"  {text}")
                print()

                if existing.strip() == text.strip():
                    print(f"  → Identiske tekster, behold eksisterende")
                    new_skip.append((name, text, art, existing))
                    continue

                choice = input(f"  Vælg [k/o/s/q]: ").strip().lower()

                if choice == "q":
                    # Afbryd — resten beholder eksisterende
                    new_skip.append((name, text, art, existing))
                    # Tilføj resterende til skip uden at spørge
                    for entry in will_skip[i:]:
                        new_skip.append(entry)
                    print(f"  → Resterende {len(will_skip) - i} beholder eksisterende")
                    break
                elif choice == "o":
                    review_overwrite.append((name, text, art, existing))
                    print(f"  ✓ Markeret til overskrivning")
                elif choice == "s":
                    print(f"\n  Indtast sammenskrivning (afslut med tom linje):")
                    lines = []
                    while True:
                        line = input("    ")
                        if line == "":
                            break
                        lines.append(line)
                    custom = " ".join(lines).strip()
                    if custom:
                        review_custom.append((name, custom, art, existing))
                        print(f"  ✓ Markeret til sammenskrivning")
                    else:
                        new_skip.append((name, text, art, existing))
                        print(f"  → Tom indtastning, beholder eksisterende")
                else:
                    # k eller andet → behold
                    new_skip.append((name, text, art, existing))
        except KeyboardInterrupt:
            print(f"\n\n  ⚠ Afbrudt af bruger.")
            # Resten beholder eksisterende
            already_handled = (len(review_overwrite) + len(review_custom)
                               + len(new_skip))
            for entry in will_skip[already_handled:]:
                new_skip.append(entry)

        will_skip = new_skip

        # Tilføj review-resultater til de relevante lister
        will_overwrite.extend(review_overwrite)
        # review_custom har special-tekst, behandles særskilt
        # Vi genbruger will_overwrite-strukturen men markerer custom-tekst
        for name, custom, art, existing in review_custom:
            will_overwrite.append((name, custom, art, existing))

    # === Vis rapport ===
    print(f"\n{'═' * 72}")
    print("  Forhåndsvisning")
    print(f"{'═' * 72}\n")

    print(f"  ✓ Tomme felter, vil udfylde:    {len(will_update)}")
    if args.overwrite:
        print(f"  ⟳ Eksisterende, vil overskrive: {len(will_overwrite)}")
    else:
        print(f"  · Eksisterende, springer over:  {len(will_skip)}")
    print(f"  ? Tvetydig (flere mulige matches): {len(ambiguous)}")
    print(f"  ✗ Ikke fundet i datasæt:        {len(not_found)}")
    print()

    if will_update:
        print("  ARTER DER VIL FÅ NY FELTKENDETEGN:")
        for name, text, art, match_type in will_update[:30]:
            matched_as = art.get("Title", "?")
            note = ""
            if name.lower().strip() != matched_as.lower():
                note = f" → '{matched_as}'"
            if match_type and match_type != "exact":
                note += f" [{match_type}]"
            print(f"    • {name}{note}")
        if len(will_update) > 30:
            print(f"    ... og {len(will_update) - 30} flere")
        print()

    if args.overwrite and will_overwrite:
        print("  ARTER DER VIL FÅ FELTKENDETEGN OVERSKREVET:")
        for name, text, art, existing in will_overwrite[:20]:
            print(f"    • {name}")
            print(f"        gammel: {existing[:70]}...")
            print(f"        ny:     {text[:70]}...")
        print()

    if not args.overwrite and will_skip:
        print("  ARTER MED EKSISTERENDE FELTKENDETEGN (springes over):")
        for name, text, art, existing in will_skip[:20]:
            print(f"    • {name}")
        if len(will_skip) > 20:
            print(f"    ... og {len(will_skip) - 20} flere")
        print(f"  (kør med --overwrite for at overskrive disse)")
        print()

    if ambiguous:
        print("  TVETYDIGE NAVNE (skal præciseres i input-fil):")
        for name, text, alternatives in ambiguous:
            print(f"    • '{name}' kunne være:")
            for alt in alternatives[:5]:
                print(f"        - {alt}")
        print()

    if not_found:
        print("  ARTER DER IKKE KUNNE FINDES:")
        for name, text in not_found:
            print(f"    • {name}")
        print(f"  (ret stavemåden i input-filen, eller tilføj arten først)")
        print()

    # Beslutning
    total_changes = len(will_update) + len(will_overwrite)
    if total_changes == 0:
        print("Ingen ændringer at lave. Afslutter.")
        return 0

    print(f"{'═' * 72}")
    print(f"  Vil ændre {total_changes} arter i {args.data}")
    print(f"{'═' * 72}")

    if not args.yes:
        answer = input("\n  Fortsæt? [y/N]: ").strip().lower()
        if answer not in ("y", "yes", "j", "ja"):
            print("\nAfbrudt — ingen ændringer foretaget.")
            return 0

    # === Anvend ændringer ===
    log_init()
    log_line(f"START: {len(will_update)} update, {len(will_overwrite)} overwrite, "
             f"{len(will_skip)} skip, {len(not_found)} not_found")

    backup_path = make_backup(args.data)
    print(f"\n💾 Backup: {backup_path}")

    n_changed = 0
    for name, text, art, match_type in will_update:
        art["Feltkendetegn"] = text
        log_line(f"UPDATE  {art.get('Title', name)} (match: {match_type})")
        n_changed += 1

    for name, text, art, existing in will_overwrite:
        art["Feltkendetegn"] = text
        log_line(f"OVERWRITE  {art.get('Title', name)} | gammel: {existing[:60]}...")
        n_changed += 1

    for name, text, art, existing in will_skip:
        log_line(f"SKIP  {art.get('Title', name)} (har allerede tekst)")

    for name, text, alternatives in ambiguous:
        log_line(f"AMBIGUOUS  '{name}' — alternativer: {alternatives}")

    for name, text in not_found:
        log_line(f"NOTFOUND  '{name}'")

    save_data(args.data, data)
    log_line(f"DONE: {n_changed} ændringer gemt")

    print(f"\n✓ Gemt {n_changed} ændringer til {args.data}")
    print(f"  Log: {LOG_FILE}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
