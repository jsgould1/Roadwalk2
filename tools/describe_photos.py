#!/usr/bin/env python3
r"""
describe_photos.py  --  On-device pavement-photo captioner for RoadWalk2.

Reads a "descriptions CSV" exported from the RoadWalk2 photo-report dialog,
runs each image through a LOCAL vision model served by Ollama, and writes a
filled CSV you import back into the app (via "Import CSV", which reviews any
conflicts). Everything runs on this machine -- the photos never leave it.

PREREQUISITES (one time):
  1. Install Ollama:   winget install Ollama.Ollama      (or https://ollama.com/download)
  2. Pull a vision model, e.g.:
        ollama pull qwen2.5vl:7b        # balanced quality (default)
        ollama pull moondream           # fastest / smallest, lower quality
        ollama pull llama3.2-vision     # higher quality, slower on CPU
  3. Make sure Ollama is running (it starts a server at http://localhost:11434).

USAGE:
  python describe_photos.py --csv "photo-descriptions-2026-10-12.csv" ^
         --base "C:\Users\you\OneDrive - AECOM\Documents\!DATA\EFL\2026 NC-TN-KY"

  # the output is written next to the input as *-filled.csv unless --out is given.

Common options:
  --model NAME     Ollama model to use (default: qwen2.5vl:7b)
  --base DIR       Folder the CSV's file_path column is relative to. Not needed
                   if file_path is already an absolute path that exists.
  --overwrite      Re-caption rows that already have a description
                   (default: only fill blank descriptions).
  --limit N        Only process the first N rows that need a caption (for a test).
  --maxpx N        Resize the long edge to N px before sending (default: 1280).
  --out FILE       Output CSV path (default: <input>-filled.csv).
  --host URL       Ollama base URL (default: http://localhost:11434).

Nothing is uploaded anywhere. The only network use is Ollama talking to
localhost. (Downloading the model with `ollama pull` is a one-time fetch of
public model weights -- not your photos.)
"""

import argparse
import base64
import csv
import glob
import io
import json
import os
import sys
import time
import urllib.request
import urllib.error

try:
    from PIL import Image
except ImportError:
    sys.exit("Pillow is required:  pip install pillow")

RUBRIC = (
    "You are a pavement engineer writing a SHORT caption (about 1-2 sentences or a tight "
    "phrase list) for a pavement-condition photo report. Technical voice; vary the wording "
    "between captions; describe the pavement feature that is the focus of the photo.\n"
    "Surface types (use these terms): dense mix asphalt (HMA), Portland cement concrete "
    "(PCC), gravel, pervious pavers, chip seal (say coarse or fine), microsurfacing, "
    "crackseal. Visual cue only: faint/lighter/smoother is usually HMA; darker/coarser is "
    "usually chip seal. Do NOT infer age or newness from color.\n"
    "Name ONLY the distresses actually visible, with severity (low/medium/high): edge "
    "drop-off, edge cracking, L&T (longitudinal & transverse) cracking, block cracking, "
    "alligator (fatigue) cracking, depressions, rutting, weathering, raveling. Flag "
    "existing patching and areas needing patching. Do NOT write a checklist of absent "
    "distresses.\n"
    "Use these marking abbreviations: DYCL (double yellow centerline), SYCL (single yellow "
    "centerline), SWEL (single white edge line), SYEL (single yellow edge line). Mention "
    "edge/center striping sparingly -- only when notable or deficient, not every caption.\n"
    "Also note when relevant: traffic (induction) loops, gates, wheel stops, curbs/gutters, "
    "shoulders, speed bumps (rate good/fair/poor), sidewalks (note cracking), and historic "
    "stone swales or monuments (flag when they need protection). For curbs, note the type "
    "(stone, PCC, granite) and reveal -- flag low reveal (<2\"); ~5-6\" is normal.\n"
    "MATERIAL CAUTION: junction/pull boxes and wheel stops may be concrete OR composite "
    "(wheel stops also rubber), and curbs may be PCC, stone, or granite -- do NOT state the "
    "material unless certain; write 'material unconfirmed' if unclear.\n"
    "Signs: mention only if deficient (mildew buildup, bullet holes, bent/leaning, or not "
    "meeting MUTCD); otherwise ignore signs, vehicles, people, weather, sky, and camera.\n"
    "If field notes are provided below, treat them as AUTHORITATIVE.\n"
    "Return only the caption text -- no preamble, no quotation marks, and never use the "
    "words 'centroid', 'field notes', 'PCI', or 'rubric'."
)


def resolve_path(file_path, filename, base):
    """Find the image on disk. Tries file_path as-is, then base+file_path,
    then a recursive search for the filename under base."""
    cands = []
    if file_path:
        fp = file_path.replace("/", os.sep).replace("\\", os.sep)
        cands.append(fp)
        if base:
            cands.append(os.path.join(base, fp))
    if base and filename:
        cands.append(os.path.join(base, filename))
    for c in cands:
        if c and os.path.isfile(c):
            return c
    # last resort: recursive glob for the filename under base
    if base and filename:
        hits = glob.glob(os.path.join(base, "**", filename), recursive=True)
        if hits:
            return hits[0]
    return None


def encode_image(path, maxpx):
    """Open, downscale to maxpx on the long edge, return base64 JPEG."""
    with Image.open(path) as im:
        im = im.convert("RGB")
        w, h = im.size
        scale = min(1.0, float(maxpx) / float(max(w, h)))
        if scale < 1.0:
            im = im.resize((max(1, round(w * scale)), max(1, round(h * scale))))
        buf = io.BytesIO()
        im.save(buf, format="JPEG", quality=85)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def load_notes(path):
    """Load a field-notes CSV into a dict keyed by lowercased id.
    Columns: id (matches photo_id | filename | route | set/lot), optional
    'surface', and 'notes' (free text). Rows with the same id are merged."""
    notes = {}
    if not path:
        return notes
    if not os.path.isfile(path):
        sys.exit("Notes file not found: " + path)
    with open(path, "r", encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f):
            low = {(k or "").strip().lower(): (v or "").strip() for k, v in row.items()}
            key = (low.get("id") or low.get("route") or low.get("lot") or "").lower()
            if not key:
                continue
            surface, text = low.get("surface", ""), low.get("notes", "")
            chunk = (("Surface (field-confirmed): " + surface + ". ") if surface else "") + text
            if chunk.strip():
                notes[key] = (notes.get(key, "") + " " + chunk).strip()
    return notes


def notes_for(notes, row):
    """Gather field notes that apply to a photo, most specific first."""
    if not notes:
        return ""
    out = []
    for k in [row.get("photo_id"), row.get("filename"), row.get("route"),
              row.get("lot"), row.get("set"), row.get("park")]:
        k = (k or "").strip().lower()
        if k and k in notes and notes[k] not in out:
            out.append(notes[k])
    return "  ".join(out)


def caption_one(host, model, b64, route, sta, field_notes="", seed="", rubric=RUBRIC):
    prompt = (rubric or RUBRIC) + "\nContext (reference only, do not restate verbatim): route {}, station {}.".format(
        route or "n/a", sta or "n/a"
    )
    if field_notes:
        prompt += "\nField notes (AUTHORITATIVE):\n" + field_notes
    if seed:
        prompt += ("\nInspector seed note (AUTHORITATIVE -- the observation is correct; "
                   "incorporate it and expand it into the final caption, do not contradict it):\n" + seed)
    payload = {
        "model": model,
        "prompt": prompt,
        "images": [b64],
        "stream": False,
        "options": {"temperature": 0.2},
    }
    req = urllib.request.Request(
        host.rstrip("/") + "/api/generate",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=600) as r:
        data = json.loads(r.read().decode("utf-8"))
    text = (data.get("response") or "").strip()
    # tidy: collapse whitespace/newlines, strip wrapping quotes
    text = " ".join(text.split())
    if len(text) >= 2 and text[0] in "\"'" and text[-1] in "\"'":
        text = text[1:-1].strip()
    return text


def main():
    ap = argparse.ArgumentParser(description="Caption pavement photos locally via Ollama.")
    ap.add_argument("--csv", required=True, help="Input descriptions CSV (from RoadWalk2 export).")
    ap.add_argument("--out", help="Output CSV (default: <input>-filled.csv).")
    ap.add_argument("--base", default="", help="Folder the CSV file_path is relative to.")
    ap.add_argument("--notes", default="", help="Field-notes CSV (columns: id, surface, notes) to ground captions.")
    ap.add_argument("--rubric", default="", help="Rubric text file. If omitted, the rubric embedded in the CSV (# lines) is used, else the built-in default.")
    ap.add_argument("--model", default="qwen2.5vl:7b", help="Ollama vision model.")
    ap.add_argument("--host", default="http://localhost:11434", help="Ollama base URL.")
    ap.add_argument("--overwrite", action="store_true", help="Re-caption rows that already have a description (ignores the old text).")
    ap.add_argument("--seed-context", dest="seed_context", action="store_true", help="Use any existing description as an authoritative seed note and expand it into a full caption (blanks captioned normally).")
    ap.add_argument("--limit", type=int, default=0, help="Only process the first N rows needing a caption.")
    ap.add_argument("--maxpx", type=int, default=1280, help="Resize long edge before sending.")
    args = ap.parse_args()

    if not os.path.isfile(args.csv):
        sys.exit("CSV not found: " + args.csv)
    out_path = args.out or (os.path.splitext(args.csv)[0] + "-filled.csv")

    with open(args.csv, "r", encoding="utf-8-sig", newline="") as f:
        raw = f.read()
    # Pull any embedded rubric off the top ("# " comment lines) and strip them.
    embedded, body_lines = [], []
    in_header = True
    for ln in raw.splitlines():
        if in_header and ln.lstrip().startswith("#"):
            embedded.append(ln.lstrip()[1:].lstrip())
        else:
            in_header = False
            body_lines.append(ln)
    import io as _io
    reader = csv.DictReader(_io.StringIO("\n".join(body_lines)))
    fields = reader.fieldnames or []
    rows = list(reader)
    if "description" not in fields:
        sys.exit('CSV has no "description" column.')

    # Rubric: --rubric file wins, else embedded in the CSV, else built-in default.
    rubric = RUBRIC
    if args.rubric:
        if not os.path.isfile(args.rubric):
            sys.exit("Rubric file not found: " + args.rubric)
        with open(args.rubric, "r", encoding="utf-8-sig") as f:
            rubric = f.read().strip()
        print("Using rubric from " + args.rubric)
    elif embedded:
        rubric = "\n".join(embedded).strip()
        print("Using rubric embedded in the CSV ({} lines).".format(len(embedded)))

    notes = load_notes(args.notes)
    if notes:
        print("Loaded field notes for {} key(s).".format(len(notes)))

    # how many actually need a caption
    todo = [r for r in rows if args.overwrite or args.seed_context or not (r.get("description") or "").strip()]
    if args.limit > 0:
        todo = todo[: args.limit]
    todo_ids = set(id(r) for r in todo)
    print("Model: {}   Images to caption: {} of {} rows".format(args.model, len(todo), len(rows)))
    if not todo:
        print("Nothing to do (all rows already have descriptions; use --overwrite to redo).")
        return

    done = skipped = errors = missing = 0
    t0 = time.time()
    n = 0
    for r in rows:
        if id(r) not in todo_ids:
            skipped += 1
            continue
        n += 1
        fn = (r.get("filename") or "").strip()
        path = resolve_path((r.get("file_path") or "").strip(), fn, args.base)
        tag = "[{}/{}] {}".format(n, len(todo), fn or r.get("photo_id"))
        if not path:
            print(tag + "  -- IMAGE NOT FOUND (set --base or fix file_path)")
            missing += 1
            continue
        try:
            b64 = encode_image(path, args.maxpx)
            seed = (r.get("description") or "").strip() if args.seed_context else ""
            cap = caption_one(args.host, args.model, b64, r.get("route"), r.get("sta"), notes_for(notes, r), seed, rubric)
            if not cap:
                raise RuntimeError("empty response")
            r["description"] = cap
            done += 1
            print(tag + "  ->  " + (cap[:90] + ("..." if len(cap) > 90 else "")))
        except urllib.error.URLError as e:
            sys.exit(
                "\nCannot reach Ollama at {} ({}).\n"
                "Start Ollama and run:  ollama pull {}\n".format(args.host, e, args.model)
            )
        except Exception as e:
            print(tag + "  -- ERROR: " + str(e))
            errors += 1

    with open(out_path, "w", encoding="utf-8", newline="") as f:
        # keep the rubric at the top of the filled CSV (app import skips # lines)
        for ln in rubric.split("\n"):
            f.write("# " + ln + "\n")
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)

    dt = time.time() - t0
    print(
        "\nDone. captioned {}  |  skipped(existing) {}  |  missing {}  |  errors {}  |  {:.0f}s".format(
            done, skipped, missing, errors, dt
        )
    )
    print("Wrote: " + out_path)
    print('Import it in RoadWalk2 -> Photo report -> "Import CSV".')


if __name__ == "__main__":
    main()
