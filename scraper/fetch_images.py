"""
fetch_images.py
===============

Downloader plantefotos fra Naturbasens API for arter der mangler billeder.

Algoritme (efterligner Program.cs):
  1. Læser botanik_final.json + image_manifest.json
  2. Finder arter med Naturbasen_TaxaID men UDEN billeder i manifestet
  3. For hver art:
     - Henter kandidater fra Naturbasens API (FilnavnAzure-felter)
     - Probe'r dimensioner og bytes for hvert billede
     - Ranker efter målbredde (1200px) og størrelse (~320 KB)
     - Downloader top-MAX_IMAGES_PER_SPECIES (default 20) til images/
  4. Efter alle downloads: kører update-image-manifest.ps1 (R2-upload + manifest)

Brug:
    python fetch_images.py                       (alle arter uden billeder)
    python fetch_images.py --only "Skov-Fyr"     (kun én art)
    python fetch_images.py --limit 5             (test på 5)
    python fetch_images.py --dry-run             (vis kun, download ikke)
    python fetch_images.py --no-upload           (skip kald af ps1-script)
    python fetch_images.py --max-images 10       (færre billeder pr. art)

Kræver:
    pip install requests
"""

import sys
import os
import json
import argparse
import re
import time
import random
import struct
import subprocess
from pathlib import Path
from datetime import datetime

import requests


# =============================================================================
# Indstillinger — efterligner C# Program.cs
# =============================================================================

DATA_FILE = Path("../data/botanik_final.json")
MANIFEST_FILE = Path("../data/image_manifest.json")
IMAGES_DIR = Path("../images")
LOG_FILE = Path("fetch_images.log")
PS1_SCRIPT = Path("../update-image-manifest.ps1")  # antaget i projekt-rod

# Naturbasen API
API_URL = "https://www.naturbasen.dk/umbraco/api/species/GetSpeciesPhotos"
BLOB_ORIGINAL = "https://naturbasenimg.blob.core.windows.net/obsfoto/"
GALLERI = "bedsteid"
API_PAGE_SIZE = 60
API_TOPN = 5000

# Kvalitetsmål
MAX_IMAGES_PER_SPECIES = 20
TARGET_WIDTH_PX = 1200
MIN_WIDTH_PX = 800
TARGET_BYTES = 320_000
MAX_BYTES_SOFT = 420_000
MIN_BYTES = 120_000

# Rank-budget
RANK_MIN_PROBES = 60
RANK_MAX_PROBES = 400
RANK_GOOD_SCORE = 150.0
RANK_GOOD_MULT = 8

# Pauser
PAUSE_PROBE_MS = 80
PAUSE_BETWEEN_DOWNLOADS = (0.5, 5.0)  # sek
PAUSE_BETWEEN_SPECIES = (1.5, 15.0)
PAUSE_BETWEEN_API_PAGES = 0.15

HEADERS = {
    "User-Agent": "PlantefotosDownloader/2.0 (private use; python)",
    "Accept": "application/json,text/plain,*/*",
    "Accept-Language": "da-DK,da;q=0.9,en-US;q=0.8,en;q=0.7",
    "Referer": "https://www.naturbasen.dk/",
}


# =============================================================================
# JPEG dimension parser
# =============================================================================

def parse_jpeg_size(data):
    """Find width+height i JPEG-header. Returner (w, h) eller (None, None)."""
    if len(data) < 4 or data[0] != 0xFF or data[1] != 0xD8:
        return None, None
    i = 2
    while i + 9 < len(data):
        if data[i] != 0xFF:
            i += 1
            continue
        while i < len(data) and data[i] == 0xFF:
            i += 1
        if i >= len(data):
            break
        marker = data[i]
        i += 1
        if marker in (0xD9, 0xDA):  # EOI/SOS
            break
        if i + 1 >= len(data):
            break
        seg_len = (data[i] << 8) | data[i + 1]
        if seg_len < 2:
            return None, None
        # SOF markers
        is_sof = (
            (0xC0 <= marker <= 0xC3) or
            (0xC5 <= marker <= 0xC7) or
            (0xC9 <= marker <= 0xCB) or
            (0xCD <= marker <= 0xCF)
        )
        if is_sof:
            if i + 7 >= len(data):
                return None, None
            h = (data[i + 3] << 8) | data[i + 4]
            w = (data[i + 5] << 8) | data[i + 6]
            return (w, h) if w > 0 and h > 0 else (None, None)
        i += seg_len
    return None, None


# =============================================================================
# HTTP helpers
# =============================================================================

def get_first_bytes(url, max_bytes=64 * 1024, timeout=20):
    """Hent kun første N bytes af et image (Range-request)."""
    try:
        h = dict(HEADERS)
        h["Range"] = f"bytes=0-{max_bytes - 1}"
        resp = requests.get(url, headers=h, timeout=timeout, stream=False)
        if resp.status_code in (200, 206):
            return resp.content
    except requests.RequestException:
        pass
    return None


def get_content_length(url, timeout=15):
    """HEAD eller GET for at finde Content-Length."""
    try:
        resp = requests.head(url, headers=HEADERS, timeout=timeout, allow_redirects=True)
        if resp.ok and "content-length" in resp.headers:
            return int(resp.headers["content-length"])
    except requests.RequestException:
        pass
    try:
        resp = requests.get(url, headers=HEADERS, timeout=timeout, stream=True)
        if resp.ok and "content-length" in resp.headers:
            return int(resp.headers["content-length"])
    except requests.RequestException:
        pass
    return None


def probe_image(url):
    """Returner (bytes, w, h) for et billede uden at downloade hele filen."""
    length = get_content_length(url)
    head = get_first_bytes(url, 64 * 1024)
    w = h = None
    if head:
        w, h = parse_jpeg_size(head)
    return length, w, h


# =============================================================================
# API
# =============================================================================

def build_api_url(taxa_id, offset, page_size):
    params = {
        "mode": "0",
        "topN": str(API_TOPN),
        "offset": str(offset),
        "pageSize": str(page_size),
        "taxFilter": "Art",
        "taxID": str(taxa_id),
        "galleri": GALLERI,
        "sort": "",
    }
    qs = "&".join(f"{k}={requests.utils.quote(v)}" for k, v in params.items())
    return f"{API_URL}?{qs}"


def fetch_candidates(taxa_id, want_count):
    """Hent kandidat-filnavne fra Naturbasens API. Returner (filenames, pages)."""
    seen = set()
    result = []
    offset = 0
    pages = 0

    while len(result) < want_count and offset < API_TOPN:
        pages += 1
        url = build_api_url(taxa_id, offset, API_PAGE_SIZE)
        try:
            resp = requests.get(url, headers=HEADERS, timeout=30)
            if not resp.ok:
                break
            data = resp.json()
        except (requests.RequestException, json.JSONDecodeError):
            break

        if not isinstance(data, list) or not data:
            break

        page_items = []
        for item in data:
            if isinstance(item, dict) and "FilnavnAzure" in item:
                fn = item.get("FilnavnAzure")
                if fn and isinstance(fn, str):
                    page_items.append(fn.strip())

        if not page_items:
            break

        for fn in page_items:
            if fn not in seen:
                seen.add(fn)
                result.append(fn)
                if len(result) >= want_count:
                    break

        offset += API_PAGE_SIZE
        time.sleep(PAUSE_BETWEEN_API_PAGES)

    return result, pages


# =============================================================================
# Ranking
# =============================================================================

def rank_candidates(filenames, min_width_px, landscape_only):
    """Probe og scor kandidater. Returner sorteret liste af filnavne."""
    probed = 0
    good_found = 0
    good_target = max(20, MAX_IMAGES_PER_SPECIES * RANK_GOOD_MULT)
    scored = []

    for fn in filenames:
        url = BLOB_ORIGINAL + fn
        length, w, h = probe_image(url)

        if w is None or h is None or length is None:
            time.sleep(PAUSE_PROBE_MS / 1000)
            continue
        if w < min_width_px:
            time.sleep(PAUSE_PROBE_MS / 1000)
            continue
        if landscape_only and w < h:
            time.sleep(PAUSE_PROBE_MS / 1000)
            continue

        probed += 1
        if probed >= RANK_MAX_PROBES:
            break

        score = 0.0
        score += 100 - abs(w - TARGET_WIDTH_PX) / 8.0
        score += 60 - abs(length - TARGET_BYTES) / 8000.0
        if length > MAX_BYTES_SOFT:
            score -= (length - MAX_BYTES_SOFT) / 15000.0
        scored.append((fn, score))

        if score >= RANK_GOOD_SCORE:
            good_found += 1

        if probed >= RANK_MIN_PROBES and good_found >= good_target:
            break

        time.sleep(PAUSE_PROBE_MS / 1000)

    scored.sort(key=lambda x: -x[1])
    return [fn for fn, _ in scored]


def merge_unique(*lists):
    seen = set()
    out = []
    for lst in lists:
        for x in lst:
            if x not in seen:
                seen.add(x)
                out.append(x)
    return out


# =============================================================================
# Download
# =============================================================================

def safe_filename(s):
    """Saniter artsnavn til filnavn."""
    s = re.sub(r'[<>:"/\\|?*]', "_", str(s))
    s = s.replace(" ", "_")
    return s.strip("_")


def get_next_index(images_dir, species_safe):
    """Find næste tilgængelige _NNN-suffix."""
    if not images_dir.exists():
        return 1
    max_n = 0
    pattern = re.compile(rf"^{re.escape(species_safe)}_(\d+)\.[^.]+$")
    for p in images_dir.iterdir():
        m = pattern.match(p.name)
        if m:
            n = int(m.group(1))
            if n > max_n:
                max_n = n
    return max_n + 1


def pick_extension(url):
    u = url.split("?")[0].split("#")[0].lower()
    for ext in (".png", ".webp", ".jpeg", ".jpg"):
        if u.endswith(ext):
            return ext
    return ".jpg"


def download_image(url, out_path, min_bytes=MIN_BYTES, timeout=60):
    """Download billede. Returner (status, bytes)."""
    out_path.parent.mkdir(parents=True, exist_ok=True)

    # Hvis findes og er stort nok, skip
    if out_path.exists():
        existing = out_path.stat().st_size
        if existing >= min_bytes:
            return "AlreadyExists", existing
        try:
            out_path.unlink()
        except OSError:
            pass

    try:
        resp = requests.get(url, headers=HEADERS, timeout=timeout, stream=True)
        if resp.status_code == 404:
            return "Http404", 0
        if not resp.ok:
            return f"Http{resp.status_code}", 0

        total = 0
        with open(out_path, "wb") as f:
            for chunk in resp.iter_content(chunk_size=8192):
                if chunk:
                    f.write(chunk)
                    total += len(chunk)

        if total < min_bytes:
            try:
                out_path.unlink()
            except OSError:
                pass
            return "TooSmall", total

        return "OK", total
    except requests.RequestException as e:
        return f"Error:{type(e).__name__}", 0


# =============================================================================
# Logning
# =============================================================================

def log_line(msg):
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(f"{datetime.now().isoformat()}  {msg}\n")


def log_init():
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(f"\n{'=' * 60}\n")
        f.write(f"Session: {datetime.now().isoformat()}\n")
        f.write(f"{'=' * 60}\n")


# =============================================================================
# Hovedlogik
# =============================================================================

def normalize_title_for_manifest(title):
    """Normaliser et artsnavn så det kan matches mod manifest-keys.

    Manifestet bygges fra filnavne hvor mellemrum er erstattet med underscore.
    Vi skal også tolerere bindestreg/mellemrum-forskelle.

    'Almindelig Brandbæger' → 'almindeligbrandbaeger'
    'Vej-Pileurt' → 'vejpileurt'
    'Almindelig_Brandbæger' → 'almindeligbrandbaeger'
    """
    if not title:
        return ""
    s = str(title).lower().strip()
    # Erstat alle mellemrum, bindestreger og underscore med ingenting
    s = re.sub(r"[\s\-_]+", "", s)
    # Konvertér æ/ø/å til ae/oe/aa for at tolerere variationer
    s = s.replace("æ", "ae").replace("ø", "oe").replace("å", "aa")
    return s


def find_arter_uden_billeder(data, manifest):
    """Find arter med TaxaID men uden billeder i manifestet.

    Bruger normaliseret matching, så 'Almindelig Brandbæger' i JSON
    matcher 'Almindelig_Brandbæger' i manifestet.
    """
    # Byg lookup-set af normaliserede manifest-keys
    manifest_normalized = set()
    for key, imgs in manifest.items():
        if imgs:  # kun keys der faktisk har billeder
            manifest_normalized.add(normalize_title_for_manifest(key))

    targets = []
    skipped_slaegt = 0
    skipped_no_taxa = 0

    for art in data:
        title = art.get("Title", "")
        taxa_id = art.get("Naturbasen_TaxaID")
        slug = art.get("Naturbasen_Slug")

        if not title:
            continue

        # Spring slægts-poster og grupper over
        title_lower = title.lower()
        is_slaegt = (
            "(gruppe)" in title_lower
            or "slægt" in title_lower
            or "(s. l.)" in title_lower
            or art.get("niveau") == "slægt"
        )
        if is_slaegt:
            skipped_slaegt += 1
            continue

        if not (taxa_id and slug):
            skipped_no_taxa += 1
            continue

        # Tjek om der er billeder i manifest (med normalisering)
        norm_title = normalize_title_for_manifest(title)
        if norm_title in manifest_normalized:
            continue

        targets.append(art)

    print(f"  (sprang over: {skipped_slaegt} slægter/grupper, "
          f"{skipped_no_taxa} uden TaxaID/slug)")

    return targets


def process_species(art, images_dir, max_images=MAX_IMAGES_PER_SPECIES):
    """Behandl én art. Returner stats-dict."""
    title = art.get("Title", "?")
    slug = art.get("Naturbasen_Slug")
    taxa_id_str = art.get("Naturbasen_TaxaID")

    try:
        taxa_id = int(taxa_id_str)
    except (TypeError, ValueError):
        print(f"  ⚠ Ugyldigt TaxaID: {taxa_id_str}")
        return {"downloaded": 0, "errors": 1}

    species_safe = safe_filename(title)
    gallery_url = f"https://www.naturbasen.dk/billeder/{taxa_id}/{slug}?m=bedsteid"

    print(f"\n{'═' * 72}")
    print(f"  {title} (taxa {taxa_id})")
    print(f"{'═' * 72}")
    log_line(f"START {title} ({taxa_id})")

    # Hent kandidater
    want = max(200, max_images * 15)
    print(f"  Henter kandidater fra API...")
    filenames, pages = fetch_candidates(taxa_id, want)
    print(f"  → {len(filenames)} kandidater fra {pages} sider")

    if not filenames:
        log_line(f"NOCANDIDATES {title}")
        return {"downloaded": 0, "errors": 1}

    # Rank
    print(f"  Ranker (min {MIN_WIDTH_PX}px, landscape)...")
    ranked = rank_candidates(filenames, MIN_WIDTH_PX, landscape_only=True)
    print(f"  → {len(ranked)} efter primær ranking")

    if len(ranked) < max_images:
        print(f"  Fallback (allow portrait)...")
        ranked2 = rank_candidates(filenames, MIN_WIDTH_PX, landscape_only=False)
        ranked = merge_unique(ranked, ranked2)
        print(f"  → {len(ranked)} efter fallback")

    if len(ranked) < max_images:
        print(f"  Fallback (700px+, all aspects)...")
        ranked3 = rank_candidates(filenames, 700, landscape_only=False)
        ranked = merge_unique(ranked, ranked3)
        print(f"  → {len(ranked)} efter dybt fallback")

    # Download
    next_index = get_next_index(images_dir, species_safe)
    stats = {"downloaded": 0, "already": 0, "too_small": 0, "not_found": 0, "errors": 0}

    for fn in ranked:
        if stats["downloaded"] >= max_images:
            break

        url = BLOB_ORIGINAL + fn
        ext = pick_extension(url)
        out_file = images_dir / f"{species_safe}_{next_index:03d}{ext}"
        next_index += 1

        status, total = download_image(url, out_file)

        if status == "OK":
            stats["downloaded"] += 1
            print(f"  ✓ {out_file.name} ({total // 1024} KB)")
            log_line(f"OK {title} | {fn} → {out_file.name} | {total} bytes")
        elif status == "AlreadyExists":
            stats["already"] += 1
        elif status == "TooSmall":
            stats["too_small"] += 1
        elif status == "Http404":
            stats["not_found"] += 1
        else:
            stats["errors"] += 1
            log_line(f"FAIL {title} | {fn} | {status}")

        # pause mellem downloads
        time.sleep(random.uniform(*PAUSE_BETWEEN_DOWNLOADS))

    print(f"\n  Resultat: {stats['downloaded']} downloaded, "
          f"{stats['already']} eksisterede, {stats['too_small']} for små, "
          f"{stats['not_found']} 404, {stats['errors']} fejl")
    log_line(f"DONE {title} | downloaded={stats['downloaded']}")

    return stats


def run_powershell_upload(ps1_path):
    """Kør PowerShell-scriptet til R2-upload + manifest-rebuild."""
    if not ps1_path.exists():
        print(f"  ⚠ {ps1_path} findes ikke — skip upload")
        return False
    print(f"\n{'═' * 72}")
    print(f"  Kører {ps1_path.name} (upload til R2 + rebuild manifest)")
    print(f"{'═' * 72}")
    try:
        # Bemærk: dette kræver at scriptet køres fra projekt-roden,
        # så vi ændrer cwd til parent af ps1-scriptet
        result = subprocess.run(
            ["powershell.exe", "-ExecutionPolicy", "Bypass", "-File", str(ps1_path.resolve())],
            cwd=ps1_path.parent.resolve(),
            check=False,
        )
        return result.returncode == 0
    except Exception as e:
        print(f"  ⚠ Fejl ved kørsel af PowerShell: {e}")
        return False


# =============================================================================
# Main
# =============================================================================

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", help="Kun denne ene art (efter Title)")
    parser.add_argument("--limit", type=int, default=None,
                        help="Maks antal arter (testing)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Vis kun arter der ville blive behandlet")
    parser.add_argument("--no-upload", action="store_true",
                        help="Skip kald af PowerShell-script efter download")
    parser.add_argument("--max-images", type=int, default=MAX_IMAGES_PER_SPECIES,
                        help=f"Maks billeder pr art (default {MAX_IMAGES_PER_SPECIES})")
    parser.add_argument("--data", type=Path, default=DATA_FILE)
    parser.add_argument("--manifest", type=Path, default=MANIFEST_FILE)
    parser.add_argument("--images-dir", type=Path, default=IMAGES_DIR)
    parser.add_argument("--ps1", type=Path, default=PS1_SCRIPT)
    args = parser.parse_args()

    # Tjek filer
    if not args.data.exists():
        print(f"FEJL: Kan ikke finde {args.data}")
        return 1
    if not args.manifest.exists():
        print(f"⚠ Ingen image_manifest.json — antager ingen arter har billeder")
        manifest = {}
    else:
        with open(args.manifest, "r", encoding="utf-8") as f:
            manifest = json.load(f)

    with open(args.data, "r", encoding="utf-8") as f:
        data = json.load(f)

    # Find targets
    if args.only:
        targets = [a for a in data if a.get("Title", "").lower() == args.only.lower()]
        if not targets:
            print(f"FEJL: '{args.only}' findes ikke")
            return 1
    else:
        targets = find_arter_uden_billeder(data, manifest)

    if args.limit:
        targets = targets[:args.limit]

    print(f"\n{'═' * 72}")
    print(f"  Arter der mangler billeder: {len(targets)}")
    print(f"  Mål pr. art: {args.max_images} billeder")
    print(f"  Output-mappe: {args.images_dir.resolve()}")
    if not args.no_upload:
        print(f"  Efter download: kører {args.ps1.name}")
    print(f"{'═' * 72}")

    if not targets:
        print("\nIngenting at gøre.")
        return 0

    if args.dry_run:
        print("\n(--dry-run)")
        for art in targets[:30]:
            print(f"  • {art.get('Title')}")
        if len(targets) > 30:
            print(f"  ... og {len(targets) - 30} flere")
        return 0

    # Estimater
    est_min = (len(targets) * (args.max_images * 1.5 + 30)) / 60  # grov
    print(f"  Estimeret tid: ~{est_min:.0f} minutter")

    # Bekræft hvis mange
    if len(targets) > 5 and not args.only:
        ans = input(f"\n  Fortsæt med {len(targets)} arter? [y/N]: ").strip().lower()
        if ans not in ("y", "yes", "j", "ja"):
            print("Afbrudt.")
            return 0

    # Forbered output-mappe
    args.images_dir.mkdir(parents=True, exist_ok=True)

    log_init()
    log_line(f"START batch: {len(targets)} arter, max_images={args.max_images}")

    total_stats = {"downloaded": 0, "errors": 0, "species_done": 0}
    start_time = time.time()

    try:
        for i, art in enumerate(targets, 1):
            elapsed = time.time() - start_time
            avg = elapsed / i if i > 0 else 0
            eta_min = int((len(targets) - i) * avg / 60)
            print(f"\n[{i}/{len(targets)}] (ETA {eta_min} min)")

            stats = process_species(art, args.images_dir, args.max_images)
            total_stats["downloaded"] += stats["downloaded"]
            total_stats["errors"] += stats["errors"]
            total_stats["species_done"] += 1

            # Pause mellem arter
            if i < len(targets):
                pause = random.uniform(*PAUSE_BETWEEN_SPECIES)
                time.sleep(pause)

    except KeyboardInterrupt:
        print(f"\n\n⚠ Afbrudt af bruger.")
        log_line("INTERRUPTED")

    elapsed_min = (time.time() - start_time) / 60

    print(f"\n{'═' * 72}")
    print(f"  Færdig.")
    print(f"  Arter behandlet:  {total_stats['species_done']}/{len(targets)}")
    print(f"  Billeder hentet:  {total_stats['downloaded']}")
    print(f"  Fejl:             {total_stats['errors']}")
    print(f"  Tid:              {elapsed_min:.1f} min")
    print(f"{'═' * 72}")
    log_line(f"DONE: species={total_stats['species_done']} downloaded={total_stats['downloaded']} errors={total_stats['errors']}")

    # Kør PowerShell-upload
    if not args.no_upload and total_stats["downloaded"] > 0:
        run_powershell_upload(args.ps1)
    elif total_stats["downloaded"] == 0:
        print("\nIngen nye billeder — skip upload.")

    return 0


if __name__ == "__main__":
    sys.exit(main())
