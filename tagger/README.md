# Botanik Tag Generator

Genererer strukturerede tags for hver art i `botanik.json` ved hjælp af Claude API.

## Hvad scriptet gør

For hver af de 600 arter sender det artens tekstdata til Claude og beder om
et struktureret JSON-objekt med tags som plantegruppe, vækstform, højde,
blomsterfarve, habitat osv. plus to lag af stikord (primære og sekundære).

Resultatet skrives til `botanik_with_tags.json` — en kopi af det oprindelige
datasæt hvor hver art har fået fire nye felter: `niveau`, `slægt`, `familie`
og `tags`.

## Forudsætninger

1. **Python 3.8+** installeret. Tjek med:
   ```
   python --version
   ```

2. **Anthropic API-nøgle.** Hent en på https://console.anthropic.com/ →
   Settings → API Keys → "Create Key". Indsæt nogle penge på kontoen
   ($10-20 er rigeligt — hele datasættet koster anslået $5-10 at tagge).

3. **Anthropic Python-biblioteket:**
   ```
   pip install anthropic
   ```

## Filer

Læg disse i samme mappe:

```
mappe/
├── generate_tags.py     (hovedscriptet)
├── prompt.py            (system-prompt og bruger-message)
├── botanik.json         (dit input-datasæt)
└── README.md            (denne fil)
```

## Kørsel

### Sæt API-nøgle

**Windows PowerShell:**
```powershell
$env:ANTHROPIC_API_KEY = "sk-ant-..."
```

**Windows CMD:**
```cmd
set ANTHROPIC_API_KEY=sk-ant-...
```

**Mac/Linux:**
```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

### Test først på 5 arter

Det er en god ide at teste opsætningen før du kører hele datasættet:

```
python generate_tags.py --limit 5
```

Efter ~30 sekunder bør du have en `botanik_with_tags.json` med 5 arter taggede
og resten urørte. Åbn filen og se om det ser fornuftigt ud.

### Kør hele datasættet

```
python generate_tags.py
```

Det tager 5-15 minutter afhængigt af parallelitet. Kør i baggrunden — du kan
trygt lade den køre mens du laver noget andet.

### Hvis det fejler halvvejs

Scriptet gemmer fremskridt i `tags_progress.json` hver 10. art. Kør med
`--resume` for at fortsætte:

```
python generate_tags.py --resume
```

### Hvis nogle arter fejler

Når scriptet er færdigt, viser det hvilke arter der fejlede. De skrives også
til `tags_failures.json`. Kør `--resume` igen — det forsøger automatisk
at tagge dem der mangler.

### Skru op eller ned for parallelitet

Default er 8 parallelle kald. Hvis du rammer rate limits, sænk til 4:

```
python generate_tags.py --workers 4
```

## Output-filer

Efter kørsel har du:

- `botanik_with_tags.json` — det færdige datasæt (det du skal bruge)
- `tags_progress.json` — fremskridt-fil (kan slettes når alt er færdigt)
- `tags_log.jsonl` — alle rå svar fra Claude (gem i tilfælde af fejlsøgning)
- `tags_failures.json` — liste over arter der fejlede (kun hvis nogen fejlede)

## Eksempel på output

For hver art tilføjes:

```json
{
  "Title": "Stjerne-Star",
  "Feltkendetegn": "...",
  ... (alle eksisterende felter bevares uændret) ...

  "niveau": "art",
  "slægt": "Star",
  "familie": "Halvgræsfamilien",
  "tags": {
    "plantegruppe": ["halvgræs"],
    "vækstform": ["tuedannende"],
    "højde": ["mellem"],
    "højde_cm": {"min": 0, "max": 40},
    "stængel_form": ["trekantet"],
    "blomster_form": ["aks"],
    "fugtighed": ["våd", "fugtig"],
    "habitat": ["eng", "klit", "hedemose", "tørveeng"],
    "stikord_primær": [
      "stjerneformede strittende frugthylstre",
      "skedehindetilhæftning ca. 1 mm bredt afrundet"
    ],
    "stikord_sekundær": [...]
  }
}
```

## Spørgsmål

Når du har kørt scriptet og fået `botanik_with_tags.json`, så send filen
tilbage så vi kan kvalitetstjekke en stikprøve, før vi bygger søgemotoren.
