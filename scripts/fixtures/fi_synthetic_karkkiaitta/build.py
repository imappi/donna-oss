"""Build (or verify) the synthetic Finnish test pack "Karkkiaitta Oy, 12/2024-01/2025".

    python3 -m fi_synthetic_karkkiaitta.build            # from scripts/fixtures/
    python3 -m fi_synthetic_karkkiaitta.build --verify   # rebuild to a temp dir, compare byte-for-byte

or, from the repo root:

    python3 scripts/fixtures/fi_synthetic_karkkiaitta/build.py [--verify]

Requires the pinned versions in requirements.txt (ReportLab, Pillow). The model
is built and checked first; nothing is written if any check fails.
"""

from __future__ import annotations

import argparse
import hashlib
import sys
import tempfile
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    __package__ = "fi_synthetic_karkkiaitta"

from . import answerkey, documents  # noqa: E402
from .model import CheckError, build_model, check_model  # noqa: E402

REPO = Path(__file__).resolve().parents[3]
FIXTURE = REPO / "data" / "evals" / "fixtures" / "fi-karkkiaitta-2024-12-2025-01"
KEY_NAME = "90 Kirjausohje ja vastaukset - Karkkiaitta Oy 12-2024-01-2025.pdf"


def render_all(M, outdir: Path):
    outdir.mkdir(parents=True, exist_ok=True)
    names = []
    for name, fn in documents.registry(M):
        fn(outdir / name)
        names.append(name)
    answerkey.render_key(outdir / KEY_NAME, M)
    names.append(KEY_NAME)
    return names


def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, default=FIXTURE / "sources")
    ap.add_argument("--verify", action="store_true", help="rebuild into a temp dir and compare with --out byte-for-byte")
    args = ap.parse_args(argv)

    M = build_model()
    try:
        check_model(M)
    except CheckError as e:
        print("RECONCILIATION CHECK FAILED - nothing written:\n" + str(e), file=sys.stderr)
        return 2
    print(f"checks passed: {len(M.journal)} journal entries, "
          f"{sum(len(v) for v in M.bank.values())} bank lines, statements close at "
          + ", ".join(f"{k} {v[-1].balance}" for k, v in M.bank.items()))

    if args.verify:
        with tempfile.TemporaryDirectory() as td:
            names = render_all(M, Path(td))
            bad = []
            for n in names:
                a, b = Path(td) / n, args.out / n
                if not b.exists() or sha(a) != sha(b):
                    bad.append(n)
            extra = sorted(p.name for p in args.out.iterdir() if p.name not in names) if args.out.exists() else []
        if bad or extra:
            print("NOT byte-identical:", *bad, *(f"(unexpected file) {x}" for x in extra), sep="\n  ", file=sys.stderr)
            return 1
        print(f"verified: {len(names)} files byte-identical")
        return 0

    names = render_all(M, args.out)
    stale = [p for p in args.out.iterdir() if p.name not in names]
    for p in stale:
        p.unlink()
    lines = [f"{sha(args.out / n)}  sources/{n}" for n in sorted(names)]
    (args.out.parent / "SHA256SUMS").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"wrote {len(names)} files to {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
