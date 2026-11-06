#!/usr/bin/env python3
"""Build the synthetic Finnish test pack Remonttipalvelu Kivijärvi Oy, Aug–Sep 2024.

    pip install -r scripts/fixtures/fi_synthetic_remontti/requirements.txt
    python3 scripts/fixtures/fi_synthetic_remontti/build.py            # (re)write the pack
    python3 scripts/fixtures/fi_synthetic_remontti/build.py --check    # rebuild to a temp dir, compare to SHA256SUMS

Everything comes from scenario.py (the one data file). The model (model.py)
refuses to build if anything fails to reconcile: every identifier's check digit,
every document's net + VAT = gross, every journal balances, every bank line's
bank leg equals the statement, both statements chain opening → closing, the
trial balance balances at 31.8. and 30.9., payroll nets equal the salary lines,
and section C (ALV return, payroll, balances) equals the journals of section B.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import scenario as S  # noqa: E402
import model  # noqa: E402
import render as R  # noqa: E402
import key as K  # noqa: E402
from model import fmt  # noqa: E402

REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
PACK_DIR = os.path.join(REPO, "data", "evals", "fixtures", S.PACK_SLUG)

SALES_FILES = {
    2401: "10 Myyntilasku 2401 - Rakennus Oy Harjuntaus.pdf",
    2402: "11 Ennakkolasku 2402 - Leena Salonen.pdf",
    2403: "12 Myyntilasku 2403 - Kattoasennus Rautio Oy.pdf",
    2404: "13 Myyntilasku 2404 - As Oy Jyväskylän Kotikallio.pdf",
    2405: "14 Myyntilasku 2405 - Marjatta Rinne.pdf",
    2406: "15 Loppulasku 2406 - Leena Salonen.pdf",
    2407: "16 Hyvityslasku 2407 - Kattoasennus Rautio Oy.pdf",
    2408: "17 Myyntilasku 2408 - Kattoasennus Rautio Oy (oikaistu).pdf",
    2409: "18 Myyntilasku 2409 - Rakennus Oy Harjuntaus.pdf",
    2410: "19 Myyntilasku 2410 - Tuomas Väänänen.pdf",
}
PURCHASE_FILES = {
    "P58811": "21 Ostolasku 58811 - Rakennustarvike Keski-Suomi.pdf",
    "P59240": "22 Ostolasku 59240 - Rakennustarvike Keski-Suomi.pdf",
    "P59377": "23 Hyvityslasku 59377 - Rakennustarvike Keski-Suomi.pdf",
    "P59611": "24 Ostolasku 59611 - Rakennustarvike Keski-Suomi.pdf",
    "P59702": "25 Ostolasku 59702 - Rakennustarvike Keski-Suomi.pdf",
    "P1187": "26 Alihankintalasku 1187 - Sähköasennus Ranta Oy.pdf",
    "P2024066": "27 Alihankintalasku 2024-066 - Laatoitus Salmela Oy.pdf",
    "P40118": "28 Vuokralasku 40118 - Konevuokraamo Jyväs Oy.pdf",
    "PNV08": "29 Leasinglasku 08-2024 - Nordvan Leasing.pdf",
    "PNV09": "30 Leasinglasku 09-2024 - Nordvan Leasing.pdf",
    "PLV07": "31 Puhelinlasku 07-2024 - Linjaverkko.pdf",
    "PLV08": "32 Puhelinlasku 08-2024 - Linjaverkko.pdf",
    "PKK08": "33 Ohjelmistolasku 08-2024 - Kätevä Kirjanpito.pdf",
    "PKK09": "34 Ohjelmistolasku 09-2024 - Kätevä Kirjanpito.pdf",
    "PVR09": "35 Vuokralasku 09-2024 - Varastokiinteistö Tourula.pdf",
    "PVR10": "36 Vuokralasku 10-2024 - Varastokiinteistö Tourula.pdf",
    "PINS": "37 Vakuutuslasku - Vakuutusyhtiö Kotiseutu.pdf",
    "PSAHKO": "38 Sähkölasku 07-2024 - Keski-Suomen Sähkönmyynti.pdf",
}
KEY_FILE = "90 Kirjausohje ja vastaukset - Remonttipalvelu Kivijärvi 08-09-2024.pdf"


def card_q(pack, cid):
    for cd in pack.card.values():
        for q in cd["purchases"]:
            if q["id"] == cid:
                return q
    raise KeyError(cid)


def build(out):
    pack = model.Pack()  # raises SystemExit on any reconciliation failure
    src = os.path.join(out, "sources")
    os.makedirs(src, exist_ok=True)
    f = lambda name: os.path.join(src, name)  # noqa: E731
    R.bank_statement(pack, "AUG", f("01 Tiliote 08-2024 - Keski-Suomen Yrityspankki.pdf"))
    R.bank_statement(pack, "SEP", f("02 Tiliote 09-2024 - Keski-Suomen Yrityspankki.pdf"))
    R.opening_balances(pack, f("03 Saldoluettelo 31.07.2024 - edellinen kirjanpitäjä.pdf"))
    R.loan_statement(pack, f("04 Yrityslaina - lainalaskelma 08-09-2024.pdf"))
    R.card_invoice(pack, "AUG", f("05 Yrityskortti - lasku 08-2024.pdf"))
    R.card_invoice(pack, "SEP", f("06 Yrityskortti - lasku 09-2024.pdf"))
    R.omavero_statement(pack, f("07 OmaVero - verotilin tapahtumat 08-09-2024.pdf"))
    R.owner_email(pack, f("08 Sähköposti 09.09 - Janne Kivijärvi.pdf"))
    for no, name in SALES_FILES.items():
        R.sales_invoice(pack, no, f(name))
    R.sumup_report(pack, f("20 SumUp tilitysraportti 23.09.2024.pdf"))
    for pid, name in PURCHASE_FILES.items():
        R.purchase_invoice(pack, pid, f(name))
    R.payslip(pack, "AUG", "e1", f("50 Palkkalaskelma 08-2024 - Lahtinen Mikko.pdf"))
    R.payslip(pack, "AUG", "e2", f("51 Palkkalaskelma 08-2024 - Haapala Ari.pdf"))
    R.payslip(pack, "SEP", "e1", f("52 Palkkalaskelma 09-2024 - Lahtinen Mikko.pdf"))
    R.payslip(pack, "SEP", "e2", f("53 Palkkalaskelma 09-2024 - Haapala Ari.pdf"))
    R.payroll_summary(pack, f("54 Palkkayhteenveto 08-09-2024.pdf"))
    R.mileage_log(pack, f("55 Ajopäiväkirja 08-09-2024 - Kivijärvi Janne.pdf"))
    R.tyel_invoice(pack, "TYEL07", f("56 TyEL-lasku 07-2024 - Kantele.pdf"))
    R.tyel_invoice(pack, "TYEL08", f("57 TyEL-lasku 08-2024 - Kantele.pdf"))
    R.yel_invoice(pack, "YEL08", f("58 YEL-lasku 08-2024 - Kantele.pdf"))
    R.yel_invoice(pack, "YEL09", f("59 YEL-lasku 09-2024 - Kantele.pdf"))
    R.tvr_invoice(pack, f("60 Työttömyysvakuutusmaksu 5-8-2024 - Työllisyysrahasto.pdf"))
    R.card_receipt(pack, card_q(pack, "C0802"), f("70 Kuitti 02.08 - RautaMaailma Seppälä.jpg"), mode="photo_rotated", seed=802)
    R.card_receipt(pack, card_q(pack, "C0806"), f("71 Kuitti 06.08 - Tankki Palokka.pdf"), mode="scan_faded", seed=806)
    R.parking_email(pack, card_q(pack, "C0809"), f("72 Kuitti 09.08 - ParkkiNyt.pdf"))
    R.lunch_receipt(pack, card_q(pack, "C0820"), f("73 Kuitti 20.08 - Lounaskeidas Vasaramäki.jpg"), seed=820)
    R.sitemeasure_invoice(pack, card_q(pack, "C0822"), f("74 Invoice 22.08 - SiteMeasure Inc (USD).pdf"))
    R.card_receipt(pack, card_q(pack, "C0827"), (f("75 Kuitti 27.08 - RautaMaailma Seppälä.jpg"), f("76 Kuitti 27.08 - RautaMaailma Seppälä (toinen kuva).jpg")),
                   mode="photo_duplicate", seed=827)
    R.cash_receipt_image(pack, f("77 Käteiskuitti 27.08 - Kuljetus T. Hämäläinen.jpg"), seed=1827)
    R.card_receipt(pack, card_q(pack, "C0903"), f("78 Kuitti 03.09 - Tankki Palokka.pdf"), mode="scan_faded", seed=903)
    R.card_receipt(pack, card_q(pack, "C0910"), f("79 Kuitti 10.09 - RautaMaailma Seppälä.jpg"), mode="photo_lowcontrast", seed=910)
    R.parking_email(pack, card_q(pack, "C0916"), f("80 Kuitti 16.09 - ParkkiNyt.pdf"))
    R.sitemeasure_invoice(pack, card_q(pack, "C0922"), f("81 Invoice 22.09 - SiteMeasure Inc (USD).pdf"))
    K.render_key(pack, f(KEY_FILE))
    miss = R.missing_glyphs()
    if miss:
        sys.exit(f"characters without a glyph in the PDF font: {miss!r} — add them to render.GLYPH_FIX")
    write_readme(pack, out)
    write_sums(out)
    return pack


def sums(out):
    rows = []
    for root, _, files in os.walk(out):
        for n in files:
            if n == "SHA256SUMS":
                continue
            p = os.path.join(root, n)
            rel = os.path.relpath(p, out)
            with open(p, "rb") as fh:
                rows.append((rel, hashlib.sha256(fh.read()).hexdigest()))
    return sorted(rows)


def write_sums(out):
    with open(os.path.join(out, "SHA256SUMS"), "w", encoding="utf-8") as fh:
        for rel, h in sums(out):
            fh.write(f"{h}  {rel}\n")


def write_readme(pack, out):
    with open(os.path.join(HERE, "README.template.md"), encoding="utf-8") as fh:
        tpl = fh.read()
    trap_rows = ["| # | Trap | Source files | Bank lines | Correct outcome |", "|---|---|---|---|---|"]
    for t in K.traps(pack):
        alt = f" *Alternative:* {t['alt']}" if t.get("alt") else ""
        esc = lambda s: s.replace("|", "\\|")  # noqa: E731
        trap_rows.append(f"| {t['id']} | **{esc(t['title'])}** — {esc(t['text'])} | {', '.join(t['docs']) or '—'} | {'; '.join(t['lines']) or '—'} | {esc(t['outcome'])}{esc(alt)} |")
    files = sorted(os.listdir(os.path.join(out, "sources")))
    ra, rs = pack.alv_return("AUG"), pack.alv_return("SEP")
    pa, ps = pack.payroll["AUG"], pack.payroll["SEP"]
    fig = [
        "| Figure | August 2024 | September 2024 |", "|---|---:|---:|",
        f"| Bank opening → closing | {fmt(pack.bank['AUG']['opening'])} → {fmt(pack.bank['AUG']['closing'])} | {fmt(pack.bank['SEP']['opening'])} → {fmt(pack.bank['SEP']['closing'])} |",
        f"| Bank lines | {len(pack.bank['AUG']['rows'])} | {len(pack.bank['SEP']['rows'])} |",
        f"| 301 output VAT (24 % / 25.5 % / AVL 9 §) | {fmt(ra['M24_tax'])} / {fmt(ra['M255_tax'])} / {fmt(ra['UPO_tax'])} | {fmt(rs['M24_tax'])} / {fmt(rs['M255_tax'])} / {fmt(rs['UPO_tax'])} |",
        f"| 318 reverse-charge construction tax | {fmt(ra['318'])} | {fmt(rs['318'])} |",
        f"| 307 deductible | {fmt(ra['307'])} | {fmt(rs['307'])} |",
        f"| **308 ALV due** | **{fmt(ra['308'])}** | **{fmt(rs['308'])}** |",
        f"| 319 / 320 construction RC sales / purchases | {fmt(ra['319'])} / {fmt(ra['320'])} | {fmt(rs['319'])} / {fmt(rs['320'])} |",
        f"| Gross wages / net paid | {fmt(pa['gross'])} / {fmt(pa['net'])} | {fmt(ps['gross'])} / {fmt(ps['net'])} |",
        f"| Owner questions (terminal = ask owner) | YEL 8/2024; missing fuel receipt 29.8. | YEL 9/2024 |",
    ]
    text = (tpl.replace("{{TRAPS}}", "\n".join(trap_rows))
               .replace("{{FIGURES}}", "\n".join(fig))
               .replace("{{FILES}}", "\n".join(f"- `{n}`" for n in files))
               .replace("{{FILE_COUNT}}", str(len(files)))
               .replace("{{YTUNNUS}}", pack.company["ytunnus"])
               .replace("{{IBAN}}", pack.company["iban"]))
    with open(os.path.join(out, "README.md"), "w", encoding="utf-8") as fh:
        fh.write(text)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true", help="rebuild into a temp dir and compare byte-for-byte with the committed SHA256SUMS")
    ap.add_argument("--out", default=PACK_DIR, help="output directory (default: the committed fixture folder)")
    args = ap.parse_args()
    if args.check:
        tmp = tempfile.mkdtemp(prefix="fi-remontti-")
        try:
            build(tmp)
            with open(os.path.join(PACK_DIR, "SHA256SUMS"), encoding="utf-8") as fh:
                committed = sorted(tuple(reversed(l.rstrip("\n").split("  ", 1))) for l in fh if l.strip())
            fresh = sums(tmp)
            if committed != fresh:
                a, b = dict(committed), dict(fresh)
                for k in sorted(set(a) | set(b)):
                    if a.get(k) != b.get(k):
                        print(f"DIFFERS: {k}")
                sys.exit("check FAILED: rebuild is not byte-identical to the committed pack")
            print(f"check OK: {len(fresh)} files rebuilt byte-identically; all reconciliation checks passed")
        finally:
            shutil.rmtree(tmp)
        return
    if os.path.isdir(os.path.join(args.out, "sources")):
        shutil.rmtree(os.path.join(args.out, "sources"))
    pack = build(args.out)
    n = len(os.listdir(os.path.join(args.out, "sources")))
    print(f"built {n} source files into {args.out}")
    print(f"ALV due: Aug {fmt(pack.alv_return('AUG')['308'])} · Sep {fmt(pack.alv_return('SEP')['308'])}")


if __name__ == "__main__":
    main()
