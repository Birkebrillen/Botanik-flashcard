"""
generate_tags.py
================

Læser botanik.json og genererer strukturerede tags for hver art ved hjælp
af Claude API. Skriver resultatet til botanik_with_tags.json.

Brug:
    1. Sæt din API-nøgle: $env:ANTHROPIC_API_KEY = "sk-ant-..."  (PowerShell)
       eller: export ANTHROPIC_API_KEY="sk-ant-..."             (bash/zsh)
    2. Installer biblioteker: pip install anthropic
    3. Kør:    python generate_tags.py

    Tilføj --resume hvis du vil fortsætte efter en afbrydelse.
    Tilføj --limit 10 for at teste på de første 10 arter.
"""

import argparse
import concurrent.futures
import json
import os
import sys
import time
from pathlib import Path

from anthropic import Anthropic, APIError, APIStatusError


# -------- konfiguration --------

INPUT_FILE = "botanik.json"
OUTPUT_FILE = "botanik_with_tags.json"
PROGRESS_FILE = "tags_progress.json"  # resume-fil
LOG_FILE = "tags_log.jsonl"           # alle rå svar gemmes her

MODEL = "claude-sonnet-4-5-20250929"  # version-pinned for konsistens
MAX_TOKENS = 2000
PARALLEL_WORKERS = 8                  # antal parallelle kald
MAX_RETRIES_PER_ART = 3
RETRY_BACKOFF_SECONDS = 5

# importer prompten fra separat fil for læsbarhed
from prompt import SYSTEM_PROMPT, build_user_message


# -------- validering --------

REQUIRED_TAG_KEYS = {
    "plantegruppe", "vækstform", "højde", "højde_cm", "livscyklus",
    "stængel_form", "stængel_overflade", "stængelmarv",
    "bladstilling", "bladform", "bladrand", "bladtype", "blad_overflade",
    "blomsterfarve", "blomster_form", "frugttype",
    "fugtighed", "næring", "jord", "lys",
    "særtræk", "lugt", "anvendelse",
    "habitat", "blomstring",
    "stikord_primær", "stikord_sekundær"
}

REQUIRED_TOP_KEYS = {"niveau", "slægt", "familie", "tags"}


def validate_tag_object(obj):
    """Returnerer (ok, fejlmeddelelse). Tjekker at alle påkrævede felter er til stede."""
    if not isinstance(obj, dict):
        return False, "ikke et dict"
    missing_top = REQUIRED_TOP_KEYS - obj.keys()
    if missing_top:
        return False, f"mangler top-felter: {missing_top}"
    if obj["niveau"] not in ("art", "slægt"):
        return False, f"niveau skal være 'art' eller 'slægt', var '{obj['niveau']}'"
    tags = obj.get("tags")
    if not isinstance(tags, dict):
        return False, "tags er ikke et dict"
    missing_tags = REQUIRED_TAG_KEYS - tags.keys()
    if missing_tags:
        return False, f"mangler tag-felter: {missing_tags}"
    # Værdier skal være lister eller null/dict (kun højde_cm)
    for k, v in tags.items():
        if k == "højde_cm":
            if v is not None and not isinstance(v, dict):
                return False, f"højde_cm skal være null eller dict"
        elif not isinstance(v, list):
            return False, f"{k} skal være en liste, var {type(v).__name__}"
    return True, ""


# -------- LLM-kald --------

def extract_tags_for_art(client, art):
    """Kald Claude med én art. Returner det validerede tag-objekt eller raise."""
    user_msg = build_user_message(art)

    last_err = None
    for attempt in range(1, MAX_RETRIES_PER_ART + 1):
        try:
            response = client.messages.create(
                model=MODEL,
                max_tokens=MAX_TOKENS,
                system=SYSTEM_PROMPT,
                messages=[{"role": "user", "content": user_msg}],
            )
            # Saml tekst
            text = ""
            for block in response.content:
                if hasattr(block, "text"):
                    text += block.text

            # Find JSON i svaret. Modellen er bedt om at returnere ren JSON,
            # men vi tillader at den pakker det ind i ```json``` eller andet.
            json_text = _extract_json(text)
            obj = json.loads(json_text)

            ok, msg = validate_tag_object(obj)
            if not ok:
                last_err = f"valideringsfejl: {msg}"
                continue

            # Log rå svar
            _append_log({
                "title": art.get("Title"),
                "attempt": attempt,
                "raw_text": text,
                "parsed": obj,
            })

            return obj

        except json.JSONDecodeError as e:
            last_err = f"JSON-parse fejl: {e}"
        except (APIStatusError, APIError) as e:
            last_err = f"API-fejl: {e}"
            time.sleep(RETRY_BACKOFF_SECONDS * attempt)
        except Exception as e:
            last_err = f"uventet fejl: {e}"

    raise RuntimeError(f"opgav efter {MAX_RETRIES_PER_ART} forsøg: {last_err}")


def _extract_json(text):
    """Pluk JSON ud af et svar der måske har ```json``` eller noget tekst omkring."""
    text = text.strip()
    # Håndter ```json ... ```
    if "```" in text:
        # find første { og sidste }
        first = text.find("{")
        last = text.rfind("}")
        if first != -1 and last != -1:
            return text[first:last + 1]
    # Antag ren JSON
    return text


def _append_log(entry):
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")


# -------- hovedflow --------

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--resume", action="store_true",
                        help="Fortsæt fra tags_progress.json")
    parser.add_argument("--limit", type=int, default=None,
                        help="Begræns til de første N arter (til test)")
    parser.add_argument("--workers", type=int, default=PARALLEL_WORKERS,
                        help=f"Antal parallelle kald (default {PARALLEL_WORKERS})")
    args = parser.parse_args()

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("FEJL: Sæt ANTHROPIC_API_KEY environment variable.")
        sys.exit(1)

    if not Path(INPUT_FILE).exists():
        print(f"FEJL: Kan ikke finde {INPUT_FILE} i denne mappe.")
        sys.exit(1)

    client = Anthropic(api_key=api_key)

    with open(INPUT_FILE, "r", encoding="utf-8") as f:
        all_arter = json.load(f)

    if args.limit:
        all_arter = all_arter[:args.limit]

    # Resume-håndtering
    done = {}
    if args.resume and Path(PROGRESS_FILE).exists():
        with open(PROGRESS_FILE, "r", encoding="utf-8") as f:
            done = json.load(f)
        print(f"Resume: {len(done)} arter allerede færdige.")

    todo = [a for a in all_arter if a.get("Title") not in done]
    print(f"Skal behandle {len(todo)} arter (springer {len(all_arter) - len(todo)} over).")

    # Parallel kørsel
    started = time.time()
    failures = []

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as executor:
        future_to_art = {executor.submit(extract_tags_for_art, client, art): art
                         for art in todo}

        for i, future in enumerate(concurrent.futures.as_completed(future_to_art), 1):
            art = future_to_art[future]
            title = art.get("Title", "?")
            try:
                tags = future.result()
                done[title] = tags

                # Gem progress hver 10. art
                if i % 10 == 0:
                    _save_progress(done)

                elapsed = time.time() - started
                rate = i / elapsed if elapsed > 0 else 0
                remaining = (len(todo) - i) / rate if rate > 0 else 0
                print(f"[{i}/{len(todo)}] OK: {title}  "
                      f"({rate:.1f}/s, ~{remaining:.0f}s tilbage)")
            except Exception as e:
                print(f"[{i}/{len(todo)}] FEJL: {title} -> {e}")
                failures.append({"title": title, "error": str(e)})

    _save_progress(done)

    # Skriv slutresultat
    print(f"\nFærdig. Skriver {OUTPUT_FILE}...")
    output = []
    for art in all_arter:
        title = art.get("Title")
        if title in done:
            merged = dict(art)
            merged.update(done[title])
            output.append(merged)
        else:
            # bevar arten uden tags hvis fejlet
            output.append(art)

    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    if failures:
        print(f"\n{len(failures)} arter fejlede:")
        for f in failures[:20]:
            print(f"  - {f['title']}: {f['error']}")
        with open("tags_failures.json", "w", encoding="utf-8") as fp:
            json.dump(failures, fp, ensure_ascii=False, indent=2)
        print(f"Alle fejl skrevet til tags_failures.json. "
              f"Du kan køre `python generate_tags.py --resume` for at prøve dem igen.")
    else:
        print("Ingen fejl. Alle arter fik tags.")


def _save_progress(done):
    with open(PROGRESS_FILE, "w", encoding="utf-8") as f:
        json.dump(done, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
