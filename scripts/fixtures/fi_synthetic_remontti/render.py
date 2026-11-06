# Renderers for the synthetic Remonttipalvelu Kivijärvi Oy pack. Every function
# takes the computed model (model.Pack) and writes one file. Output is
# deterministic: reportlab runs in invariant mode (fixed dates/ids) and every
# image "imperfection" (rotation, grain, fading) comes from a seeded RNG.
#
# Fonts come ONLY from the reportlab distribution (Bitstream Vera TTFs, the
# Courier and calligraphic Type 1 fonts it bundles), so a rebuild on another
# machine with the pinned versions reproduces the same bytes.

from __future__ import annotations

import io
import os
import random
from xml.sax.saxutils import escape

import reportlab
from reportlab import rl_config

rl_config.invariant = 1

from PIL import Image, ImageDraw, ImageFilter, ImageFont  # noqa: E402
from reportlab.lib import colors  # noqa: E402
from reportlab.lib.enums import TA_RIGHT  # noqa: E402
from reportlab.lib.pagesizes import A4, landscape  # noqa: E402
from reportlab.lib.styles import ParagraphStyle  # noqa: E402
from reportlab.lib.units import mm  # noqa: E402
from reportlab.pdfbase import pdfmetrics  # noqa: E402
from reportlab.pdfbase.ttfonts import TTFont  # noqa: E402
from reportlab.platypus import (Image as RLImage, KeepTogether, PageBreak, Paragraph, SimpleDocTemplate,  # noqa: E402
                                Spacer, Table, TableStyle)

import scenario as S  # noqa: E402
from model import ACCOUNTS, ALV_CODES, TREE_CODE, dmy, fmt, rate_label, viite  # noqa: E402

FONT_DIR = os.path.join(os.path.dirname(reportlab.__file__), "fonts")
for name, f in [("Vera", "Vera.ttf"), ("Vera-Bold", "VeraBd.ttf"), ("Vera-Italic", "VeraIt.ttf"), ("Vera-BoldItalic", "VeraBI.ttf")]:
    pdfmetrics.registerFont(TTFont(name, os.path.join(FONT_DIR, f)))
from reportlab.pdfbase.pdfmetrics import registerFontFamily  # noqa: E402

registerFontFamily("Vera", normal="Vera", bold="Vera-Bold", italic="Vera-Italic", boldItalic="Vera-BoldItalic")

MONO_PFB = os.path.join(FONT_DIR, "com_____.pfb")
MONO_BOLD_PFB = os.path.join(FONT_DIR, "cob_____.pfb")
HAND_PFB = os.path.join(FONT_DIR, "callig15.pfb")
SANS_TTF = os.path.join(FONT_DIR, "Vera.ttf")
SANS_BOLD_TTF = os.path.join(FONT_DIR, "VeraBd.ttf")

GREY = colors.HexColor("#555555")
LIGHT = colors.HexColor("#EEEEEE")
ACCENT = {
    "company": colors.HexColor("#1F5C5C"), "rtks": colors.HexColor("#C0561B"), "ranta": colors.HexColor("#1D4E89"),
    "salmela": colors.HexColor("#6B4E9B"), "konevuokra": colors.HexColor("#B8860B"), "nordvan": colors.HexColor("#0B3D2E"),
    "linja": colors.HexColor("#8B1E3F"), "kateva": colors.HexColor("#2E7D32"), "tourula": colors.HexColor("#5D4037"),
    "kotiseutu": colors.HexColor("#00587A"), "kantele": colors.HexColor("#3E2A6D"), "tvr": colors.HexColor("#004B87"),
    "kssahko": colors.HexColor("#E0A100"), "bank": colors.HexColor("#123E6B"), "vero": colors.HexColor("#0A3A73"),
    "sumup": colors.HexColor("#222222"), "parkkinyt": colors.HexColor("#0077B6"), "sitemeasure": colors.HexColor("#FF6B00"),
    "key": colors.HexColor("#333333"),
}


def st(size=8.5, bold=False, italic=False, color=colors.black, align=0, leading=None):
    font = "Vera-BoldItalic" if bold and italic else "Vera-Bold" if bold else "Vera-Italic" if italic else "Vera"
    return ParagraphStyle("x", fontName=font, fontSize=size, leading=leading or size * 1.28, textColor=color, alignment=align)


GLYPH_FIX = {"\u2192": "->", "\u2212": "-", "\u2011": "-"}
USED_CHARS = set()


def _clean(text):
    text = str(text)
    for a, b in GLYPH_FIX.items():
        text = text.replace(a, b)
    USED_CHARS.update(text)
    return text


def P(text, **kw):
    return Paragraph(escape(_clean(text)).replace("\n", "<br/>"), st(**kw))


def PR(text, **kw):  # raw markup allowed
    return Paragraph(_clean(text), st(**kw))


def missing_glyphs():
    """Characters used in any PDF paragraph that the Vera font cannot draw."""
    face = pdfmetrics.getFont("Vera").face
    return sorted(ch for ch in USED_CHARS if ch not in "\n" and ord(ch) not in face.charToGlyph)


def footer_factory(label):
    def draw(canvas, doc):
        canvas.saveState()
        canvas.setFont("Vera", 6)
        canvas.setFillColor(colors.HexColor("#9A9A9A"))
        w, _ = doc.pagesize
        canvas.drawString(doc.leftMargin, 8 * mm, f"{S.MARK} · kuvitteellinen aineisto, ei todellisia yrityksiä tai henkilöitä")
        canvas.drawRightString(w - doc.rightMargin, 8 * mm, f"{label} · sivu {doc.page}")
        canvas.restoreState()
    return draw


def build_pdf(path, story, label, pagesize=A4, margins=(16, 16, 16, 18), title=None):
    doc = SimpleDocTemplate(path, pagesize=pagesize, leftMargin=margins[0] * mm, rightMargin=margins[1] * mm,
                            topMargin=margins[2] * mm, bottomMargin=margins[3] * mm,
                            title=title or label, author="Synthetic test pack", subject=S.MARK, creator="fi_synthetic_remontti/build.py")
    f = footer_factory(label)
    doc.build(story, onFirstPage=f, onLaterPages=f)


def tbl(data, widths, style=None, repeat=0, zebra=False, head_bg=LIGHT):
    t = Table(data, colWidths=widths, repeatRows=repeat)
    base = [("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 3), ("RIGHTPADDING", (0, 0), (-1, -1), 3),
            ("TOPPADDING", (0, 0), (-1, -1), 1.6), ("BOTTOMPADDING", (0, 0), (-1, -1), 1.6)]
    if repeat:
        base.append(("BACKGROUND", (0, 0), (-1, repeat - 1), head_bg))
    if zebra:
        for i in range(repeat, len(data)):
            if (i - repeat) % 2 == 1:
                base.append(("BACKGROUND", (0, i), (-1, i), colors.HexColor("#F7F7F7")))
    t.setStyle(TableStyle(base + (style or [])))
    return t


def num(cents, **kw):
    kw.setdefault("align", TA_RIGHT)
    return P(fmt(cents), **kw)


def qty_s(q):
    return q.replace(".", ",")


def price_s(p):
    if "." in p and len(p.split(".")[1]) > 2:
        return p.replace(".", ",")
    from decimal import Decimal
    return fmt(int(Decimal(p) * 100)) if p.replace("-", "").replace(".", "").isdigit() else p


# ── virtual barcode (pankkiviivakoodi v4, national reference) ──────────────
def virtual_barcode(iban, cents, ref, due_iso):
    digits = iban.replace(" ", "")[2:]
    eur, ct = divmod(abs(cents), 100)
    if eur > 999999:
        return ""
    r = ref.replace(" ", "").rjust(20, "0")
    return f"4{digits}{eur:06d}{ct:02d}000{r}{due_iso[2:4]}{due_iso[5:7]}{due_iso[8:10]}"


# ════════════════════════════════════════════════════════════════════════════
# INVOICES
# ════════════════════════════════════════════════════════════════════════════
def invoice_pdf(path, *, label, accent, seller, buyer_lines, title, meta, lines, vat_rows, totals, notes=(), site=None,
                payment=None, show_vat_col=True, extra_blocks=(), seller_footer=None, currency="EUR"):
    A = accent
    story = []
    head_left = [PR(f"<font color='{A.hexval()}'><b>{escape(seller['name'])}</b></font>", size=15, leading=18)]
    for a in seller.get("address", []):
        head_left.append(P(a, size=8.5, color=GREY))
    if seller.get("ytunnus"):
        head_left.append(P(f"Y-tunnus {seller['ytunnus']}" + (f" · ALV-rek." if seller.get("vat_registered", True) else ""), size=8, color=GREY))
    meta_rows = [[P(k, size=7.5, color=GREY), P(v, size=8.5, bold=(k in ("Eräpäivä", "Viitenumero", "Laskun numero", "Invoice no.")))] for k, v in meta]
    mt = tbl(meta_rows, [30 * mm, 42 * mm])
    head_right = [PR(f"<font color='{A.hexval()}'><b>{escape(title)}</b></font>", size=16, leading=19, align=TA_RIGHT), Spacer(1, 3), mt]
    story.append(tbl([[head_left, head_right]], [104 * mm, 74 * mm]))
    story.append(Spacer(1, 6 * mm))
    bl = [P("LASKUTETAAN" if currency == "EUR" else "BILL TO", size=7, color=GREY)] + [P(x, size=9.5, bold=(i == 0)) for i, x in enumerate(buyer_lines)]
    story.append(tbl([[bl, ""]], [100 * mm, 78 * mm]))
    story.append(Spacer(1, 4 * mm))
    if site:
        story.append(tbl([[P("KOHDE / VIITTEENNE" if currency == "EUR" else "DETAILS", size=7, color=GREY)], [P(site, size=8.5)]], [178 * mm],
                         style=[("BOX", (0, 0), (-1, -1), 0.4, colors.HexColor("#CCCCCC"))]))
        story.append(Spacer(1, 3 * mm))
    hdr = ["KUVAUS", "MÄÄRÄ", "YKS.", "À-HINTA", "ALV", "YHTEENSÄ"] if currency == "EUR" else ["DESCRIPTION", "QTY", "", "UNIT", "TAX", "AMOUNT"]
    data = [[P(h, size=7, bold=True, color=colors.white, align=(TA_RIGHT if i in (1, 3, 5) else 0)) for i, h in enumerate(hdr)]]
    for l in lines:
        data.append([P(l[0], size=8.3), P(l[1], size=8.3, align=TA_RIGHT), P(l[2], size=8.3), P(l[3], size=8.3, align=TA_RIGHT),
                     P(l[4], size=8.3), P(l[5], size=8.3, align=TA_RIGHT)])
    story.append(tbl(data, [80 * mm, 17 * mm, 13 * mm, 21 * mm, 23 * mm, 24 * mm], repeat=1, zebra=True, head_bg=A,
                     style=[("LINEBELOW", (0, -1), (-1, -1), 0.5, GREY)]))
    story.append(Spacer(1, 3 * mm))
    if vat_rows:
        vd = [[P(h, size=7, color=GREY, align=(TA_RIGHT if i else 0)) for i, h in enumerate(["ALV-ERITTELY" if currency == "EUR" else "TAX", "VEROTON", "ALV", "VEROLLINEN"])]]
        for r in vat_rows:
            vd.append([P(r[0], size=8), num(r[1], size=8), num(r[2], size=8), num(r[3], size=8)])
        story.append(tbl([[tbl(vd, [34 * mm, 22 * mm, 20 * mm, 22 * mm], style=[("LINEABOVE", (0, 1), (-1, 1), 0.3, GREY)]),
                           tbl([[P(k, size=9 if b else 8.3, bold=b), P(v, size=9.5 if b else 8.3, bold=b, align=TA_RIGHT)] for k, v, b in totals],
                               [44 * mm, 30 * mm], style=[("LINEABOVE", (0, -1), (-1, -1), 0.8, colors.black)])]],
                         [102 * mm, 76 * mm]))
    else:
        story.append(tbl([["", tbl([[P(k, size=9 if b else 8.3, bold=b), P(v, size=9.5 if b else 8.3, bold=b, align=TA_RIGHT)] for k, v, b in totals],
                                   [44 * mm, 30 * mm], style=[("LINEABOVE", (0, -1), (-1, -1), 0.8, colors.black)])]], [102 * mm, 76 * mm]))
    for b in extra_blocks:
        story.append(Spacer(1, 3 * mm))
        story.append(b)
    if notes:
        story.append(Spacer(1, 4 * mm))
        for n in notes:
            story.append(P(n, size=8, color=colors.HexColor("#333333")))
            story.append(Spacer(1, 1.5))
    if payment:
        story.append(Spacer(1, 6 * mm))
        story.append(payment_slip(**payment))
    if seller_footer:
        story.append(Spacer(1, 4 * mm))
        story.append(P(seller_footer, size=7, color=GREY))
    build_pdf(path, story, label)


def payment_slip(*, iban, bic, payee, payer_lines, ref, due, amount, message=None):
    rows = [
        [P("Saajan tilinumero\nMottagarens kontonummer", size=6.5, color=GREY), P(f"{iban}   BIC {bic}", size=9, bold=True)],
        [P("Saaja\nMottagare", size=6.5, color=GREY), P(payee, size=9)],
        [P("Maksajan nimi ja osoite", size=6.5, color=GREY), P("\n".join(payer_lines), size=8.5)],
    ]
    if message:
        rows.append([P("Viesti", size=6.5, color=GREY), P(message, size=8.5)])
    rows += [
        [P("Viitenumero\nRef. nr", size=6.5, color=GREY), P(ref, size=10, bold=True)],
        [P("Eräpäivä / Förfallodag", size=6.5, color=GREY), P(dmy(due) + f"      Euro   {fmt(amount)}", size=10, bold=True)],
    ]
    t = tbl(rows, [36 * mm, 142 * mm], style=[("BOX", (0, 0), (-1, -1), 0.8, colors.black), ("LINEBELOW", (0, 0), (-1, -2), 0.3, GREY),
                                              ("LINEAFTER", (0, 0), (0, -1), 0.3, GREY)])
    vb = virtual_barcode(iban, amount, ref, due)
    parts = [P("TILISIIRTO · GIRERING", size=7, bold=True, color=GREY), t]
    if vb:
        parts.append(P(f"Virtuaaliviivakoodi: {vb}", size=7, color=GREY))
    return KeepTogether(parts)


def _company_as_seller(pack):
    co = pack.company
    return dict(name=co["name"], address=co["address"], ytunnus=co["ytunnus"])


def _buyer_lines(pack, key, with_vat=False):
    p = pack.parties[key]
    out = [p["name"]] + p.get("address", [])
    if with_vat and p.get("vat"):
        out.append(f"Y-tunnus {p['ytunnus']} · ALV-tunniste {p['vat']}")
    elif p.get("ytunnus"):
        out.append(f"Y-tunnus {p['ytunnus']}")
    return out


def _doc_lines(doc):
    out = []
    for l in doc["lines"]:
        rate = l["rate"]
        out.append([l["desc"], qty_s(l["qty"]), l["unit"], price_s(l["price_str"]),
                    "0 %" if rate == "RC" else ("—" if rate == "0" else rate_label(rate)), fmt(l["amount"])])
    return out


def _vat_rows(doc):
    rows = []
    for rate, net in doc["groups"].items():
        lab = "0 % käännetty verovelvollisuus" if rate == "RC" else ("Veroton" if rate == "0" else rate_label(rate))
        rows.append((lab, net, doc["vat_by_rate"][rate], net + doc["vat_by_rate"][rate]))
    return rows


def sales_invoice(pack, no, path):
    s = pack.sales[no]
    co = pack.company
    cust = pack.parties[s["party"]]
    rc = "RC" in s["groups"]
    credit = bool(s.get("credit_of"))
    title = "HYVITYSLASKU" if credit else ("ENNAKKOLASKU" if s.get("advance") else ("LOPPULASKU" if s.get("advance_info") else "LASKU"))
    meta = [("Laskun numero", str(no)), ("Laskun päivämäärä", dmy(s["date"]))]
    if not credit and not s.get("paid_by_card"):
        meta += [("Eräpäivä", dmy(s["due"])), ("Maksuehto", "14 pv netto" if s["due"] != s["date"] else "—"), ("Viitenumero", s["viite"])]
    if s.get("supply"):
        a, b = s["supply"]
        meta.append(("Työ suoritettu", f"{dmy(a, True)}–{dmy(b)}" if a != b else dmy(a)))
    if s.get("your_ref"):
        meta.append(("Viitteenne", s["your_ref"]))
    meta.append(("Viivästyskorko", "korkolain mukaan"))
    lines = _doc_lines(s)
    totals = [("Veroton yhteensä", fmt(s["net"]), False), ("ALV yhteensä", fmt(s["vat"]), False)]
    blocks = []
    notes = []
    if rc:
        notes.append("Käännetty verovelvollisuus, AVL 8 c §. Ostaja on verovelvollinen rakentamispalvelun ostosta (Arvonlisäverodirektiivi 2006/112/EY art. 199).")
    if credit:
        notes.append(f"Hyvitys koskee laskua {s['credit_of']} ({dmy(pack.sales[s['credit_of']]['date'])}).")
        notes.append(s["site"])
        totals.append(("HYVITETTÄVÄ YHTEENSÄ", fmt(s["gross"]) + " €", True))
    elif s.get("paid_by_card"):
        totals.append(("YHTEENSÄ", fmt(s["gross"]) + " €", True))
        totals.append(("Maksettu kortilla " + dmy(s["paid_by_card"]), "-" + fmt(s["gross"]), False))
        totals.append(("MAKSETTAVAA", "0,00 €", True))
    else:
        totals.append(("MAKSETTAVAA YHTEENSÄ", fmt(s["gross"]) + " €", True))
    if s.get("advance_info"):
        a = s["advance_info"]
        blocks.append(tbl([[P("URAKAN ERITTELY", size=7, color=GREY), ""],
                           [P("Urakkahinta yhteensä, veroton (urakkasopimus 12.8.2024)"), P(fmt(s["contract_net"]), align=TA_RIGHT)],
                           [P(f"Ennakkolasku {a['no']}, maksettu 23.8.2024: veroton {fmt(a['net'])} + ALV 24 % {fmt(a['vat'])} = {fmt(a['gross'])} — jo maksettu, ei sisälly tähän laskuun"), P("-" + fmt(a["net"]), align=TA_RIGHT)],
                           [P("Tällä laskulla laskutettava osa, veroton", bold=True), P(fmt(s["net"]), bold=True, align=TA_RIGHT)]],
                          [140 * mm, 38 * mm], style=[("BOX", (0, 0), (-1, -1), 0.4, colors.HexColor("#CCCCCC"))]))
        notes.append("Urakka on valmistunut ja luovutettu 6.9.2024. Palvelu on suoritettu verokannan muutoksen jälkeen, joten laskutettavaan osaan sovelletaan 25,5 %:n verokantaa. Ennen 1.9.2024 maksettuun ennakkoon on sovellettu 24 %:n verokantaa.")
    if s.get("household_work") is not None:
        hw = s["household_work"]
        if s.get("advance_info"):
            hw_note = f"Kotitalousvähennykseen oikeuttava työn osuus koko urakasta (sis. ALV 25,5 %): {fmt(hw)} €. Ennakkolasku 2402 koski materiaaleja."
        else:
            hw_note = f"Kotitalousvähennykseen oikeuttava työn osuus (sis. ALV): {fmt(hw)} €."
        blocks.append(tbl([[P(hw_note + " Yritys on merkitty ennakkoperintärekisteriin.", size=8.5, bold=True)]], [178 * mm],
                          style=[("BOX", (0, 0), (-1, -1), 0.6, ACCENT["company"]), ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#EEF5F5"))]))
    if s.get("paid_by_card"):
        notes.append(f"Maksettu pankkikortilla työn luovutuksen yhteydessä {dmy(s['paid_by_card'])} (SumUp, tapahtuma {S.SUMUP['tx_id']}).")
    if s.get("corrects"):
        notes.append(f"Tämä lasku korvaa laskun {s['corrects']}, joka on hyvitetty hyvityslaskulla 2407.")
    if s.get("advance"):
        notes.append("Ennakkomaksu urakkasopimuksen mukaisesti. Loppulasku lähetetään urakan valmistuttua; ennakko vähennetään loppulaskusta.")
    payment = None
    if not credit and not s.get("paid_by_card"):
        payment = dict(iban=co["iban"], bic=S.BANK["bic"], payee=co["name"], payer_lines=[cust["name"]] + cust.get("address", [])[-1:],
                       ref=s["viite"], due=s["due"], amount=s["gross"])
    seller = _company_as_seller(pack)
    foot = f"{co['name']} · {', '.join(co['address'])} · Y-tunnus {co['ytunnus']} · ALV-tunniste {co['vat']} · {co['phone']} · {co['email']} · IBAN {co['iban']} · Ennakkoperintärekisterissä, ALV-rekisterissä"
    site = s.get("site") if not credit else None
    invoice_pdf(path, label=f"Remonttipalvelu Kivijärvi Oy · {title.lower()} {no}", accent=ACCENT["company"], seller=seller,
                buyer_lines=_buyer_lines(pack, s["party"], with_vat=rc or s["party"] == "rautio"), title=title, meta=meta, lines=lines,
                vat_rows=_vat_rows(s), totals=totals, notes=notes, site=site, payment=payment, extra_blocks=blocks, seller_footer=foot)


def purchase_invoice(pack, pid, path):
    p = pack.purchases[pid]
    party = pack.parties[p["party"]]
    co = pack.company
    seller = dict(name=party["name"], address=party.get("address", []), ytunnus=party.get("ytunnus"))
    meta = [("Laskun numero", p["no"]), ("Päivämäärä", dmy(p["date"]))]
    if not p.get("credit_of"):
        meta += [("Eräpäivä", dmy(p["due"])), ("Viitenumero", p.get("viite", "—"))]
    if p.get("period"):
        meta.append(("Laskutuskausi", p["period"]))
    elif p.get("delivered") and not p.get("insurance"):
        meta.append(("Toimituspäivä", dmy(p["delivered"])))
    meta.append(("Asiakasnumero", f"{abs(hash_s(p['party'] + co['name'])) % 900000 + 100000}"))
    if p.get("private_to_owner"):
        buyer = [pack.people["owner"]["name"]] + pack.people["owner"]["home"]
    else:
        buyer = [co["name"]] + co["address"] + ([f"Y-tunnus {co['ytunnus']} · ALV-tunniste {co['vat']}"] if p.get("reverse_charge") else [])
    if p.get("insurance"):
        ipt = sum(l["amount"] for l in p["lines"] if l["desc"].startswith("Vakuutusmaksuvero"))
        totals = [("Vakuutusmaksut", fmt(p["net"] - ipt), False), ("Vakuutusmaksuvero", fmt(ipt), False)]
    else:
        totals = [("Veroton yhteensä", fmt(p["net"]), False), ("ALV yhteensä", fmt(p["vat"]), False)]
    totals.append(("HYVITYS YHTEENSÄ" if p.get("credit_of") else "MAKSETTAVAA", fmt(p["gross"]) + " €", True))
    notes = [p["note"]] if p.get("note") else []
    if p.get("reverse_charge"):
        notes.insert(0, "Käännetty verovelvollisuus, AVL 8 c §. Ostaja on verovelvollinen rakentamispalvelun ostosta.")
    payment = None
    if not p.get("credit_of"):
        payment = dict(iban=party["iban"], bic=S.BANK["bic"], payee=party["name"], payer_lines=buyer[:1],
                       ref=p.get("viite", ""), due=p["due"], amount=p["gross"])
    title = p.get("title", "LASKU")
    foot = f"{party['name']} · {', '.join(party.get('address', []))}" + (f" · Y-tunnus {party['ytunnus']} · ALV-tunniste {party['vat']}" if party.get("ytunnus") else "") + f" · IBAN {party['iban']}"
    vat_rows = _vat_rows(p) if not p.get("insurance") else []
    invoice_pdf(path, label=f"{party['name']} · {title.lower()} {p['no']}", accent=ACCENT.get(p["party"], GREY), seller=seller, buyer_lines=buyer,
                title=title, meta=meta, lines=_doc_lines(p), vat_rows=vat_rows, totals=totals, notes=notes, payment=payment, seller_footer=foot)


def hash_s(s):
    h = 0
    for ch in s:
        h = (h * 131 + ord(ch)) % 1000000007
    return h


# ════════════════════════════════════════════════════════════════════════════
# PENSION / UNEMPLOYMENT INSURANCE INVOICES
# ════════════════════════════════════════════════════════════════════════════
def tyel_invoice(pack, tid, path):
    t = pack.tyel[tid]
    ins = pack.parties["kantele"]
    co = pack.company
    lines = [[f"TyEL-maksu {t['month']}, tulorekisteriin ilmoitettu palkkasumma {fmt(t['base'])} € × {S.RATES['tyel_total_2024_pct'].replace('.', ',')} %",
              "1", "erä", fmt(t["total"]), "—", fmt(t["total"])]]
    blocks = []
    if t.get("split"):
        rows = [[P("Erittely", size=7, color=GREY), P("Palkat", size=7, color=GREY, align=TA_RIGHT), P("Työntekijän osuus", size=7, color=GREY),
                 P("Työntekijä €", size=7, color=GREY, align=TA_RIGHT)]]
        for _, name, g, pc, amt in t["split"]:
            rows.append([P(name, size=8), num(g, size=8), P(pc.replace(".", ",") + " %", size=8), num(amt, size=8)])
        rows.append([P("Työnantajan osuus (maksu − työntekijäosuudet)", size=8, bold=True), "", "", num(t["employer"], size=8, bold=True)])
        blocks.append(tbl(rows, [80 * mm, 30 * mm, 34 * mm, 34 * mm], style=[("BOX", (0, 0), (-1, -1), 0.4, colors.HexColor("#CCCCCC"))]))
    invoice_pdf(path, label=f"{ins['name']} · TyEL {t['month']}", accent=ACCENT["kantele"],
                seller=dict(name=ins["name"], address=ins["address"], ytunnus=ins["ytunnus"]), buyer_lines=[co["name"]] + co["address"] + [f"Y-tunnus {co['ytunnus']}"],
                title="TyEL-LASKU", meta=[("Laskun numero", t["no"]), ("Päivämäärä", dmy(t["date"])), ("Eräpäivä", dmy(t["due"])), ("Viitenumero", t["viite"]),
                                          ("Vakuutusnumero", "56-3317452-T"), ("Viivästyskorko", "TyEL 22 §")],
                lines=lines, vat_rows=[], totals=[("MAKSETTAVAA", fmt(t["total"]) + " €", True)],
                notes=["Työeläkevakuutusmaksut ovat arvonlisäverottomia. Maksu perustuu tulorekisteriin ilmoitettuihin palkkoihin.",
                       "Työntekijän eläkemaksu 7,15 % (17–52-v. ja 63–67-v.), 8,65 % (53–62-v.). Keskimääräinen TyEL-maksu 2024: 24,85 %."],
                payment=dict(iban=ins["iban"], bic=S.BANK["bic"], payee=ins["name"], payer_lines=[co["name"]], ref=t["viite"], due=t["due"], amount=t["total"]),
                extra_blocks=blocks, seller_footer=f"{ins['name']} · Y-tunnus {ins['ytunnus']} · työeläkevakuutus")


def yel_invoice(pack, yid, path):
    y = pack.yel[yid]
    ins = pack.parties["kantele"]
    o = pack.people["owner"]
    lines = [[f"YEL-vakuutusmaksu {y['month']}: työtulo {fmt(int(S.YEL['work_income'].replace('.', '')))} €/v × {S.RATES['yel_2024_pct'].replace('.', ',')} % / 12",
              "1", "kk", fmt(y["amount"]), "—", fmt(y["amount"])]]
    invoice_pdf(path, label=f"{ins['name']} · YEL {y['month']}", accent=ACCENT["kantele"],
                seller=dict(name=ins["name"], address=ins["address"], ytunnus=ins["ytunnus"]), buyer_lines=[o["name"]] + o["home"],
                title="YEL-LASKU", meta=[("Laskun numero", y["no"]), ("Päivämäärä", dmy(y["date"])), ("Eräpäivä", dmy(y["due"])), ("Viitenumero", y["viite"]),
                                         ("Vakuutettu", o["name"]), ("Vakuutusnumero", "46-0379913-Y")],
                lines=lines, vat_rows=[], totals=[("MAKSETTAVAA", fmt(y["amount"]) + " €", True)],
                notes=["Yrittäjän eläkevakuutus (YEL) on vakuutetun yrittäjän henkilökohtainen lakisääteinen vakuutus. Maksu on arvonlisäveroton.",
                       "Yritystoiminta: Remonttipalvelu Kivijärvi Oy (toimitusjohtaja, omistusosuus yli 50 %)."],
                payment=dict(iban=ins["iban"], bic=S.BANK["bic"], payee=ins["name"], payer_lines=[o["name"]], ref=y["viite"], due=y["due"], amount=y["amount"]),
                seller_footer=f"{ins['name']} · Y-tunnus {ins['ytunnus']} · yrittäjän eläkevakuutus")


def tvr_invoice(pack, path):
    t = pack.tvr
    ins = pack.parties["tvr"]
    co = pack.company
    lines = [[f"Palkkasumma {m}", "", "", "", "", fmt(g)] for m, g in t["months"]]
    lines.append([f"Työnantajan työttömyysvakuutusmaksu {S.RATES['tvr_employer_2024_pct'].replace('.', ',')} % × {fmt(t['base'])}", "1", "erä", fmt(t["employer"]), "—", fmt(t["employer"])])
    lines.append([f"Palkansaajan työttömyysvakuutusmaksu {S.RATES['tvr_employee_2024_pct'].replace('.', ',')} % × {fmt(t['base'])} (pidätetty palkoista)", "1", "erä", fmt(t["employee"]), "—", fmt(t["employee"])])
    invoice_pdf(path, label="Työllisyysrahasto · työttömyysvakuutusmaksu 5–8/2024", accent=ACCENT["tvr"],
                seller=dict(name=ins["name"], address=ins["address"]), buyer_lines=[co["name"]] + co["address"] + [f"Y-tunnus {co['ytunnus']}"],
                title="LASKU", meta=[("Laskun numero", t["no"]), ("Päivämäärä", dmy(t["date"])), ("Eräpäivä", dmy(t["due"])), ("Viitenumero", t["viite"]),
                                     ("Laskutusjakso", "palkat 5–8/2024")],
                lines=lines, vat_rows=[], totals=[("MAKSETTAVAA", fmt(t["total"]) + " €", True)],
                notes=["Maksu lasketaan tulorekisteriin ilmoitetusta palkkasummasta. Työnantajan maksu 0,27 % (palkkasumma enintään 2 337 000 €), palkansaajan maksu 0,79 % vuonna 2024.",
                       "Työttömyysvakuutusmaksut ovat arvonlisäverottomia."],
                payment=dict(iban=ins["iban"], bic=S.BANK["bic"], payee=ins["name"], payer_lines=[co["name"]], ref=t["viite"], due=t["due"], amount=t["total"]),
                seller_footer="Työllisyysrahasto · SYNTEETTISET maksutiedot (ei todellinen tilinumero tai viite)")


# ════════════════════════════════════════════════════════════════════════════
# BANK STATEMENT
# ════════════════════════════════════════════════════════════════════════════
def bank_statement(pack, m, path):
    stt = pack.bank[m]
    co = pack.company
    B = S.BANK
    per = ("01.08.2024", "31.08.2024") if m == "AUG" else ("01.09.2024", "30.09.2024")
    story = []
    head = [[PR(f"<font color='{ACCENT['bank'].hexval()}'><b>{B['name']}</b></font>", size=14),
             PR("<b>TILIOTE</b><br/>Tilitapahtumat · Kontoutdrag", size=11, align=TA_RIGHT)]]
    story.append(tbl(head, [110 * mm, 68 * mm]))
    story.append(Spacer(1, 3 * mm))
    info = [[P("TILINOMISTAJA", size=6.5, color=GREY), P("TILI (IBAN)", size=6.5, color=GREY), P("BIC", size=6.5, color=GREY), P("TILIOTE NRO", size=6.5, color=GREY)],
            [P(co["name"] + "\n" + ", ".join(co["address"]), size=8.5), P(co["iban"], size=9, bold=True), P(B["bic"], size=8.5),
             P(("8" if m == "AUG" else "9") + "/2024", size=8.5)],
            [P("Y-TUNNUS", size=6.5, color=GREY), P("KAUSI", size=6.5, color=GREY), P("VALUUTTA", size=6.5, color=GREY), P("TILITYYPPI", size=6.5, color=GREY)],
            [P(co["ytunnus"], size=8.5), P(f"{per[0]} – {per[1]}", size=8.5), P("EUR", size=8.5), P("Yrityskäyttötili", size=8.5)]]
    story.append(tbl(info, [60 * mm, 55 * mm, 28 * mm, 35 * mm], style=[("BOX", (0, 0), (-1, -1), 0.5, GREY)]))
    story.append(Spacer(1, 4 * mm))
    hdr = ["KIRJ.PVM\nARVOPVM", "TAPAHTUMA\nSAAJA / MAKSAJA", "VIITE / VIESTI", "ARKISTOINTITUNNUS", "MÄÄRÄ EUR", "SALDO EUR"]
    data = [[P(h, size=6.5, bold=True, color=colors.white, align=(TA_RIGHT if i >= 4 else 0)) for i, h in enumerate(hdr)]]
    prev = dmy(pack.bank[m]["rows"][0]["date"])
    data.append([P(f"{'31.07.2024' if m == 'AUG' else '31.08.2024'}", size=7.5), P("ALKUSALDO", size=7.5, bold=True), "", "", "", num(stt["opening"], size=7.5, bold=True)])
    for r in stt["rows"]:
        d = dmy(r["date"])
        data.append([P(f"{d}\n{d}", size=7.2), P(f"{r['type']}\n{r['party']}", size=7.2), P(r["msg"], size=7.2), P(r["archive"], size=6.2, color=GREY),
                     P(fmt(r["amount"], plus=True), size=7.5, bold=True, align=TA_RIGHT), num(r["balance"], size=7.5)])
    data.append([P(per[1], size=7.5), P("LOPPUSALDO", size=7.5, bold=True), "", "", "", num(stt["closing"], size=7.5, bold=True)])
    story.append(tbl(data, [18 * mm, 50 * mm, 40 * mm, 30 * mm, 20 * mm, 22 * mm], repeat=1, zebra=True, head_bg=ACCENT["bank"]))
    ins = [r["amount"] for r in stt["rows"] if r["amount"] > 0]
    outs = [r["amount"] for r in stt["rows"] if r["amount"] < 0]
    story.append(Spacer(1, 4 * mm))
    story.append(tbl([[P(f"Panot {len(ins)} kpl", size=8), num(sum(ins), size=8), P(f"Otot {len(outs)} kpl", size=8), num(sum(outs), size=8),
                       P("Loppusaldo", size=8, bold=True), num(stt["closing"], size=8, bold=True)]],
                     [30 * mm, 28 * mm, 30 * mm, 28 * mm, 32 * mm, 30 * mm], style=[("BOX", (0, 0), (-1, -1), 0.5, GREY)]))
    story.append(Spacer(1, 4 * mm))
    story.append(P("Tiliote on laadittu sähköisesti. Tarkista tapahtumat — mahdollisista virheistä on ilmoitettava pankille viimeistään 14 päivän kuluessa tiliotteen saamisesta. "
                   "Korttiostot yrityksen luottokortilla (KSYP Yritys Visa) laskutetaan erikseen kuukausittain.", size=7, color=GREY))
    story.append(P(f"{B['name']} · {B['address']} · {B['service']}", size=7, color=GREY))
    build_pdf(path, story, f"{B['name']} · tiliote {'8' if m == 'AUG' else '9'}/2024", margins=(14, 14, 14, 18))


# ════════════════════════════════════════════════════════════════════════════
# OTHER STATEMENTS
# ════════════════════════════════════════════════════════════════════════════
def opening_balances(pack, path):
    ob = pack.opening_balances
    O = S.OPENING
    story = [PR("<b>SALDOLUETTELO 31.7.2024</b>", size=14), P(f"{pack.company['name']} · Y-tunnus {pack.company['ytunnus']} · Tilikausi 1.1.–31.12.2024", size=9, color=GREY),
             Spacer(1, 2 * mm),
             P("Edellisen kirjanpitäjän luovuttama saldoluettelo. Heinäkuun 2024 kirjanpito ja ALV-ilmoitus 7/2024 on tehty ja kausi suljettu. "
               "Kirjanpito jatkuu 1.8.2024 alkaen. Tililuettelon numerointi on uuden kirjanpitäjän (sama kuin kirjausohjeessa).", size=8.5),
             Spacer(1, 4 * mm)]
    rows = [[P("TILI", size=7, bold=True), P("NIMI", size=7, bold=True), P("DEBET", size=7, bold=True, align=TA_RIGHT), P("KREDIT", size=7, bold=True, align=TA_RIGHT)]]
    for a, v in ob.items():
        rows.append([P(a, size=8.5), P(ACCOUNTS[a], size=8.5), num(v, size=8.5) if v > 0 else "", num(-v, size=8.5) if v < 0 else ""])
    rows.append([P("", size=8), P("YHTEENSÄ", size=8.5, bold=True), num(sum(v for v in ob.values() if v > 0), size=8.5, bold=True),
                 num(-sum(v for v in ob.values() if v < 0), size=8.5, bold=True)])
    story.append(tbl(rows, [18 * mm, 100 * mm, 30 * mm, 30 * mm], repeat=1, zebra=True))
    story.append(Spacer(1, 5 * mm))
    story.append(P("ERITTELYT", size=9, bold=True))
    op = pack.opening_payroll
    det = [
        ["1700 Myyntisaamiset", f"Lasku 2398 Rakennus Oy Harjuntaus 19.7.2024, eräpäivä 2.8.2024, {fmt(ob['1700'])} € (käännetty verovelvollisuus)."],
        ["1800 Siirtosaamiset", "Elokuun 2024 halli- ja toimistovuokra, maksettu 31.7.2024 (850,00 € + ALV 24 %; ALV vähennetty heinäkuussa)."],
        ["2939 ALV-velka", f"ALV 6/2024 {O['alv_payable'][0]['amount'].replace('.', ',')} € (eräpäivä 12.8.2024) ja ALV 7/2024 {O['alv_payable'][1]['amount'].replace('.', ',')} € (eräpäivä 12.9.2024). Molemmat ilmoitettu OmaVerossa."],
        ["2931 / 2932", f"Heinäkuun palkkojen ({fmt(op['july_gross'])} €) ennakonpidätys {fmt(op['withholding_july'])} € ja työnantajan sava 1,16 % {fmt(op['sava_july'])} €, eräpäivä 12.8.2024."],
        ["2935 TyEL-velka", f"TyEL 7/2024 (24,85 % × {fmt(op['july_gross'])}) = {fmt(op['tyel_july'])} €, laskutetaan elokuussa, eräpäivä 20.8.2024."],
        ["2936 TVR-velka", f"Työttömyysvakuutusmaksut palkoista 5–7/2024 ({fmt(op['tvr_base_may_jul'])} €): työnantaja 0,27 % + palkansaaja 0,79 % = {fmt(op['tvr_accrued_may_jul'])} €. Työllisyysrahasto laskuttaa syyskuussa."],
        ["2885 Yrityskorttivelka", f"Heinäkuun korttilasku {fmt(ob['2885'] * -1)} €, eräpäivä 16.8.2024 (ostot kirjattu heinäkuulle)."],
        ["2620 Yrityslaina", f"Laina {S.LOAN['no']}, lyhennys 500,00 €/kk, korko 12 kk euribor + 1,80 %."],
    ]
    story.append(tbl([[P(a, size=8, bold=True), P(b, size=8)] for a, b in det], [40 * mm, 138 * mm], zebra=True))
    story.append(Spacer(1, 4 * mm))
    story.append(P("Tilitoimisto Kirjanpito Salmi (edellinen kirjanpitäjä) · luovutettu 5.8.2024", size=7.5, color=GREY))
    build_pdf(path, story, "Saldoluettelo 31.7.2024")


def loan_statement(pack, path):
    L = S.LOAN
    story = [PR(f"<font color='{ACCENT['bank'].hexval()}'><b>{S.BANK['name']}</b></font>", size=13), Spacer(1, 2 * mm),
             PR("<b>YRITYSLAINA — LAINALASKELMA JA MAKSUERÄT 8–9/2024</b>", size=11), Spacer(1, 2 * mm),
             tbl([[P("Lainansaaja", size=7.5, color=GREY), P(pack.company["name"] + f" ({pack.company['ytunnus']})", size=8.5)],
                  [P("Laina", size=7.5, color=GREY), P(f"{L['no']} · tasalyhenteinen, {L['principal_per_instalment'].replace('.', ',')} €/kk", size=8.5)],
                  [P("Korko", size=7.5, color=GREY), P(f"12 kk euribor {L['euribor_pct'].replace('.', ',')} % + marginaali {L['margin_pct'].replace('.', ',')} % = {L['rate_pct'].replace('.', ',')} % (tarkistus 29.12.2023); korkopäivät tod./360", size=8.5)],
                  [P("Veloitustili", size=7.5, color=GREY), P(pack.company["iban"], size=8.5)]], [30 * mm, 148 * mm]),
             Spacer(1, 4 * mm)]
    hdr = ["ERÄPÄIVÄ / VELOITUS", "KORKOJAKSO", "PÄIVÄT", "PÄÄOMA ENNEN", "KORKO", "LYHENNYS", "ERÄ YHTEENSÄ", "PÄÄOMA JÄLKEEN"]
    rows = [[P(h, size=6.5, bold=True, color=colors.white) for h in hdr]]
    for i in pack.loan:
        rows.append([P(dmy(i["date"]), size=8), P(f"{dmy(i['from'], True)}–{dmy(i['to'])}", size=8), P(str(i["days"]), size=8), num(i["balance_before"], size=8),
                     num(i["interest"], size=8), num(i["principal"], size=8), num(i["total"], size=8, bold=True), num(i["balance_after"], size=8)])
    story.append(tbl(rows, [26 * mm, 32 * mm, 12 * mm, 22 * mm, 18 * mm, 20 * mm, 24 * mm, 24 * mm], repeat=1, head_bg=ACCENT["bank"], zebra=True))
    story.append(Spacer(1, 3 * mm))
    for i in pack.loan:
        if i.get("note"):
            story.append(P(i["note"], size=8))
    story.append(P("Korko = pääoma × korko-% × päivät / 360. Lainanhoitoerät veloitetaan tililtä eräpäivänä.", size=8, color=GREY))
    build_pdf(path, story, f"Yrityslaina {L['no']} · lainalaskelma 8–9/2024")


def card_invoice(pack, m, path):
    cd = pack.card[m]
    co = pack.company
    story = [tbl([[PR(f"<font color='{ACCENT['bank'].hexval()}'><b>{S.BANK['name']}</b></font><br/>KSYP Yritys Visa", size=12),
                   PR("<b>LUOTTOKORTTILASKU</b>", size=13, align=TA_RIGHT)]], [110 * mm, 68 * mm]), Spacer(1, 3 * mm)]
    meta = [("Kortinhaltija", f"{pack.people['owner']['name']} / {co['name']}"), ("Kortti", co["card_mask"]),
            ("Laskutuskausi", f"{dmy(cd['period'][0])} – {dmy(cd['period'][1])}"), ("Laskun päivä", dmy(cd["invoice_date"])),
            ("Eräpäivä", dmy(cd["due"])), ("Viitenumero", cd["viite"]), ("Luottoraja", "5 000,00 €")]
    story.append(tbl([[P(k, size=7.5, color=GREY), P(v, size=8.5, bold=k in ("Eräpäivä", "Viitenumero"))] for k, v in meta], [34 * mm, 144 * mm]))
    story.append(Spacer(1, 4 * mm))
    hdr = ["OSTOPVM", "KIRJ.PVM", "KAUPPIAS / TAPAHTUMA", "ALKUP. SUMMA", "KURSSI", "EUR"]
    rows = [[P(h, size=6.8, bold=True, color=colors.white, align=(TA_RIGHT if i >= 3 else 0)) for i, h in enumerate(hdr)]]
    for q in cd["purchases"]:
        import datetime as _dt
        bdate = (_dt.date.fromisoformat(q["date"]) + _dt.timedelta(days=1 if _dt.date.fromisoformat(q["date"]).weekday() < 4 else 3)).isoformat()
        orig = f"{q['usd'].replace('.', ',')} USD" if "usd" in q else ""
        rows.append([P(dmy(q["date"], True), size=8), P(dmy(bdate, True), size=8), P(q["stmt"], size=8), P(orig, size=8, align=TA_RIGHT),
                     P(q["fx"].replace(".", ",") if "fx" in q else "", size=8, align=TA_RIGHT), num(q["gross"], size=8)])
        if q.get("fx_fee"):
            rows.append([P(dmy(q["date"], True), size=8), P(dmy(bdate, True), size=8), P(f"VALUUTTAMUUNNOSMAKSU {q['fx_fee_pct'].replace('.', ',')} %", size=8), "", "",
                         num(q["fx_fee"], size=8)])
    rows.append(["", "", P("LASKUTUSKAUDEN OSTOT YHTEENSÄ", size=8, bold=True), "", "", num(cd["total"], size=8.5, bold=True)])
    story.append(tbl(rows, [16 * mm, 16 * mm, 80 * mm, 24 * mm, 18 * mm, 24 * mm], repeat=1, zebra=True, head_bg=ACCENT["bank"]))
    story.append(Spacer(1, 4 * mm))
    story.append(P("Laskun koko summa veloitetaan eräpäivänä yrityksen käyttötililtä (suoraveloitus). Valuuttamääräiset ostot on muunnettu euroiksi Visan kurssilla "
                   "tapahtuman käsittelypäivänä; valuuttamuunnosmaksu 1,70 %. Kortin käyttö yksityisostoksiin on kielletty yrityksen ohjeen mukaan.", size=7.5, color=GREY))
    story.append(Spacer(1, 4 * mm))
    story.append(tbl([[P("MAKSU", size=7, color=GREY), P(f"Laskun summa {fmt(cd['total'])} € veloitetaan suoraveloituksena tililtä {co['iban']} eräpäivänä {dmy(cd['due'])}. Viite {cd['viite']}.", size=9, bold=True)]],
                     [20 * mm, 158 * mm], style=[("BOX", (0, 0), (-1, -1), 0.8, colors.black)]))
    build_pdf(path, story, f"KSYP Yritys Visa · lasku {'8' if m == 'AUG' else '9'}/2024")


def omavero_statement(pack, path):
    o = pack.omavero
    co = pack.company
    story = [PR(f"<font color='{ACCENT['vero'].hexval()}'><b>OmaVero</b></font> · Verohallinto", size=13), Spacer(1, 2 * mm),
             PR("<b>VEROTILI — OMA-ALOITTEISET VEROT · TAPAHTUMAT 1.8.–30.9.2024</b>", size=10.5),
             P(f"{co['name']} · Y-tunnus {co['ytunnus']} · Oma-aloitteisten verojen viitenumero {co['tax_ref']} · Tulostettu 1.10.2024", size=8.5, color=GREY),
             Spacer(1, 4 * mm)]
    hdr = ["PÄIVÄ", "TAPAHTUMA", "ERÄPÄIVÄ", "VELOITUS", "MAKSU", "VEROTILIN SALDO"]
    rows = [[P(h, size=6.8, bold=True, color=colors.white, align=(TA_RIGHT if i >= 3 else 0)) for i, h in enumerate(hdr)]]
    bal = 0
    rows.append([P("01.08.2024", size=8), P("Alkusaldo (avoimet erät)", size=8), "", "", "", num(0, size=8)])
    events = []
    for name, due, amt in o["aug_items"]:
        events.append(("2024-08-12", name, due, amt, 0))
    events.append(("2024-08-21", "Maksu, viite " + co["tax_ref"], "", 0, o["aug_total"]))
    events.append(("2024-08-21", f"Viivästyskorko {o['days_late']} pv (13.8.–21.8.2024), {S.RATES['tax_late_interest_2024_pct'].replace('.', ',')} %, erät 12.8.2024",
                   "2024-09-12", o["interest"], 0))
    for name, due, amt in o["sep_items"][:3]:
        events.append(("2024-09-12", name, due, amt, 0))
    events.append(("2024-09-12", "Maksu, viite " + co["tax_ref"], "", 0, o["sep_total"]))
    for d, name, due, deb, pay in events:
        bal += deb - pay
        rows.append([P(dmy(d), size=8), P(name, size=8), P(dmy(due) if due else "", size=8), num(deb, size=8) if deb else "", num(pay, size=8) if pay else "",
                     num(-bal, size=8)])
    story.append(tbl(rows, [20 * mm, 80 * mm, 20 * mm, 19 * mm, 19 * mm, 20 * mm], repeat=1, zebra=True, head_bg=ACCENT["vero"]))
    story.append(Spacer(1, 3 * mm))
    story.append(P("Verotilin saldo: negatiivinen = maksettavaa. Kaikki oma-aloitteiset verot (ALV, ennakonpidätykset, työnantajan sairausvakuutusmaksu) maksetaan samalla viitenumerolla; "
                   "maksut kohdistetaan erääntyneisiin veroihin eräpäiväjärjestyksessä. Viivästyskorko lasketaan myöhässä maksetulle verolle jokaiselta myöhästyneeltä päivältä.", size=7.5, color=GREY))
    story.append(Spacer(1, 2 * mm))
    story.append(P("Tulevat erät: ALV 8/2024 (eräpäivä 12.10.2024), ennakonpidätys ja sava 9/2024 (12.10.2024), ALV 9/2024 (12.11.2024) — ilmoitukset antamatta 1.10.2024.", size=7.5))
    story.append(P("Verohallinnon maksutiedot tässä testiaineistossa ovat SYNTEETTISIÄ.", size=7, color=GREY))
    build_pdf(path, story, "OmaVero · verotilin tapahtumat 8–9/2024")


def owner_email(pack, path):
    e = S.OWNER_EMAIL
    story = [tbl([[P("Lähettäjä:", size=8, color=GREY), P(f"{pack.people['owner']['name']} <{pack.company['email']}>", size=8.5)],
                  [P("Vastaanottaja:", size=8, color=GREY), P("kirjanpito@tilitoimisto.example", size=8.5)],
                  [P("Päivämäärä:", size=8, color=GREY), P(dmy(e["date"][:10]) + " " + e["date"][11:], size=8.5)],
                  [P("Aihe:", size=8, color=GREY), P(e["subject"], size=9, bold=True)],
                  [P("Liitteet:", size=8, color=GREY), P("IMG_0827_1.jpg, IMG_0827_2.jpg, kuitti_sepeli.jpg, +9", size=8.5)]],
                 [28 * mm, 150 * mm], style=[("LINEBELOW", (0, -1), (-1, -1), 0.5, GREY)]), Spacer(1, 5 * mm)]
    for line in e["body"]:
        story.append(P(line if line else " ", size=9.5, leading=13))
    build_pdf(path, story, "Sähköposti · J. Kivijärvi 9.9.2024")


def sumup_report(pack, path):
    su = pack.sumup
    story = [PR("<b>SumUp</b> · Tilitysraportti", size=13), Spacer(1, 2 * mm),
             P(f"Kauppias: {pack.company['name']} · Tilitystili {pack.company['iban']}", size=8.5, color=GREY), Spacer(1, 4 * mm)]
    rows = [[P(h, size=7, bold=True) for h in ["TAPAHTUMA-AIKA", "TUNNUS", "KORTTI", "MYYNTI", "PALKKIO", "NETTO"]],
            [P(dmy(su["tx_date"]) + " 15:42", size=8), P(su["tx_id"], size=8), P("Visa Debit •••• 0921", size=8), num(su["gross"], size=8), num(-su["fee"], size=8), num(su["net"], size=8)],
            [P("Yhteensä", size=8, bold=True), "", "", num(su["gross"], size=8, bold=True), num(-su["fee"], size=8, bold=True), num(su["net"], size=8, bold=True)]]
    story.append(tbl(rows, [32 * mm, 30 * mm, 36 * mm, 26 * mm, 26 * mm, 28 * mm], repeat=1, zebra=True))
    story.append(Spacer(1, 3 * mm))
    story.append(P(f"Tilityspäivä {dmy(su['settle_date'])}. Palkkio {su['fee_pct'].replace('.', ',')} % korttimaksusta (maksupalvelu, arvonlisäveroton rahoituspalvelu). "
                   "Viesti tilisiirrossa: tilityspäivä ja tapahtumatunnus.", size=8))
    build_pdf(path, story, "SumUp · tilitysraportti 23.9.2024")


# ════════════════════════════════════════════════════════════════════════════
# PAYROLL
# ════════════════════════════════════════════════════════════════════════════
def payslip(pack, m, e, path):
    pm = pack.payroll[m]
    r = pm["emps"][e]
    p = pack.people[e]
    co = pack.company
    mon = "8" if m == "AUG" else "9"
    story = [PR(f"<b>PALKKALASKELMA {mon}/2024</b>", size=14), Spacer(1, 2 * mm)]
    info = [["Työnantaja", f"{co['name']} · Y-tunnus {co['ytunnus']}", "Maksupäivä", dmy(pm["payday"])],
            ["Työntekijä", f"{p['name']} · {p['hetu']}", "Palkkajakso", f"{dmy(pm['period'][0], True)}–{dmy(pm['period'][1])}"],
            ["Tehtävä", p["role"], "Tili", p["iban"]],
            ["Työehtosopimus", "Rakennusalan työehtosopimus (tuntipalkka)", "Verokortti", f"Ennakonpidätys {p['tax_pct'].replace('.', ',')} % (verokortti 2024, tuloraja ei ylity)"]]
    story.append(tbl([[P(a, size=7, color=GREY), P(b, size=8.3), P(c_, size=7, color=GREY), P(d, size=8.3)] for a, b, c_, d in info],
                     [24 * mm, 70 * mm, 22 * mm, 62 * mm], style=[("BOX", (0, 0), (-1, -1), 0.4, GREY)]))
    story.append(Spacer(1, 4 * mm))
    rows = [[P(h, size=7, bold=True, align=(TA_RIGHT if i else 0)) for i, h in enumerate(["PALKKALAJI / PIDÄTYS", "PERUSTE", "À / %", "MÄÄRÄ EUR"])]]
    rows.append([P("Tuntipalkka"), P(f"{r['hours']} h", align=TA_RIGHT), P(r["hourly"].replace(".", ","), align=TA_RIGHT), num(r["gross"])])
    rows.append([P("BRUTTOPALKKA YHTEENSÄ", bold=True), "", "", num(r["gross"], bold=True)])
    rows.append([P("Ennakonpidätys"), num(r["gross"]), P(r["tax_pct"].replace(".", ",") + " %", align=TA_RIGHT), num(-r["withholding"])])
    rows.append([P("Työntekijän eläkemaksu (TyEL)" + (" — 53–62-vuotias" if r["tyel_pct"] == S.RATES["tyel_employee_53_62_pct"] else "")), num(r["gross"]),
                 P(r["tyel_pct"].replace(".", ",") + " %", align=TA_RIGHT), num(-r["tyel"])])
    rows.append([P("Työntekijän työttömyysvakuutusmaksu"), num(r["gross"]), P(S.RATES["tvr_employee_2024_pct"].replace(".", ",") + " %", align=TA_RIGHT), num(-r["tvr"])])
    if r["km_amt"]:
        rows.append([P("Kilometrikorvaus, verovapaa (oma auto)"), P(f"{r['km']} km", align=TA_RIGHT), P("0,57", align=TA_RIGHT), num(r["km_amt"])])
    if r["pd_full"]:
        rows.append([P("Kotimaan kokopäiväraha, verovapaa"), P(f"{r['pd_full']} pv", align=TA_RIGHT), P("51,00", align=TA_RIGHT), num(r["pd_full"] * 5100)])
    if r["pd_partial"]:
        rows.append([P("Kotimaan osapäiväraha, verovapaa"), P(f"{r['pd_partial']} pv", align=TA_RIGHT), P("24,00", align=TA_RIGHT), num(r["pd_partial"] * 2400)])
    if r["advance"]:
        rows.append([P(f"Palkkaennakko maksettu {dmy(S.SALARY_ADVANCE['date'])}"), "", "", num(-r["advance"])])
    rows.append([P("MAKSETAAN TILILLE", bold=True), "", "", num(r["net"], bold=True)])
    story.append(tbl(rows, [90 * mm, 30 * mm, 24 * mm, 34 * mm], repeat=1, zebra=True,
                     style=[("LINEABOVE", (0, -1), (-1, -1), 0.8, colors.black), ("LINEABOVE", (0, 2), (-1, 2), 0.4, GREY)]))
    story.append(Spacer(1, 3 * mm))
    notes = []
    if r["km"]:
        notes.append(("Kilometrikorvaus: " + S.E1_KM_ROUTES[m] + "."))
    if r.get("trips"):
        notes.append(r["trips"])
    notes.append(f"Palkka maksettu {dmy(pm['payday'])} tililtä {co['iban']}. Tulorekisteri-ilmoitus annettu {dmy(pm['tr_reported'])} (määräaika 5 päivää maksupäivästä). "
                 "Palkanmaksu kerran kuukaudessa paikallisen sopimuksen mukaisesti.")
    notes.append("Työnantajan maksut (eivät vähennä nettopalkkaa): TyEL-työnantajaosuus, sairausvakuutusmaksu 1,16 %, työttömyysvakuutusmaksu 0,27 % — ks. palkkayhteenveto.")
    for n in notes:
        story.append(P(n, size=7.8, color=colors.HexColor("#333333")))
        story.append(Spacer(1, 1.5))
    build_pdf(path, story, f"Palkkalaskelma {mon}/2024 · {p['name']}")


def payroll_summary(pack, path):
    story = [PR("<b>PALKKAYHTEENVETO 8–9/2024 · TYÖNANTAJAMAKSUT</b>", size=13), P(f"{pack.company['name']} · Y-tunnus {pack.company['ytunnus']}", size=8.5, color=GREY),
             Spacer(1, 4 * mm)]
    for m in ("AUG", "SEP"):
        pm = pack.payroll[m]
        mon = "8" if m == "AUG" else "9"
        story.append(P(f"Palkat {mon}/2024 · maksupäivä {dmy(pm['payday'])} · tulorekisteriin {dmy(pm['tr_reported'])}", size=10, bold=True))
        hdr = ["", "BRUTTO", "ENNAKONPID.", "TyEL TT", "TVR TT", "KM-KORV.", "PÄIVÄRAHAT", "ENNAKKO", "NETTO"]
        rows = [[P(h, size=6.8, bold=True, align=(TA_RIGHT if i else 0)) for i, h in enumerate(hdr)]]
        for e, r in pm["emps"].items():
            rows.append([P(pack.people[e]["name"], size=8)] + [num(v, size=8) for v in (r["gross"], r["withholding"], r["tyel"], r["tvr"], r["km_amt"], r["pd_amt"], r["advance"], r["net"])])
        rows.append([P("Yhteensä", size=8, bold=True)] + [num(v, size=8, bold=True) for v in (pm["gross"], pm["withholding"], pm["tyel_employee"], pm["tvr_employee"], pm["km"], pm["pd"], pm["advance"], pm["net"])])
        story.append(tbl(rows, [34 * mm] + [18 * mm] * 8, repeat=1, zebra=True))
        story.append(Spacer(1, 2 * mm))
        emp = [["TyEL yhteensä 24,85 % palkkasummasta", fmt(pm["tyel_total"])], ["— josta työntekijäosuudet (pidätetty)", fmt(pm["tyel_employee"])],
               ["— työnantajaosuus", fmt(pm["tyel_employer"])], ["Työnantajan sairausvakuutusmaksu 1,16 %", fmt(pm["sava"])],
               ["Työnantajan työttömyysvakuutusmaksu 0,27 %", fmt(pm["tvr_employer"])],
               ["Verohallinnolle eräpäivänä 12.%s.2024: ennakonpidätys + sava" % ("9" if m == "AUG" else "10"), fmt(pm["withholding"] + pm["sava"])],
               ["TyEL-laskun eräpäivä", "20.%s.2024" % ("9" if m == "AUG" else "10")]]
        story.append(tbl([[P(a, size=8), P(b, size=8, align=TA_RIGHT)] for a, b in emp], [120 * mm, 40 * mm], zebra=True))
        story.append(Spacer(1, 5 * mm))
    story.append(P("Työtapaturma- ja ammattitautivakuutus: Keskinäinen Vakuutusyhtiö Kotiseutu, ennakkomaksu neljännesvuosittain. Omistaja (toimitusjohtaja) ei nostanut palkkaa 8–9/2024; hän on YEL-vakuutettu.", size=8))
    build_pdf(path, story, "Palkkayhteenveto 8–9/2024")


def mileage_log(pack, path):
    mi = pack.mileage
    o = pack.people["owner"]
    story = [PR("<b>AJOPÄIVÄKIRJA JA KILOMETRIKORVAUSHAKEMUS 8–9/2024</b>", size=12.5),
             P(f"Hakija: {o['name']} (toimitusjohtaja) · Auto: oma henkilöauto, rek. KJV-731 · Korvaus 0,57 €/km (Verohallinnon päätös 2024)", size=8.5, color=GREY),
             P(f"Koti: {', '.join(o['home'])} · Yhtiö: {pack.company['name']}, {', '.join(pack.company['address'])}", size=8.5, color=GREY),
             Spacer(1, 4 * mm)]
    rows = [[P(h, size=7, bold=True, align=(TA_RIGHT if h in ('KM', 'KORVAUS €') else 0)) for h in ["PVM", "REITTI", "TARKOITUS", "KM", "KORVAUS €"]]]
    for r in mi["log"]:
        rows.append([P(dmy(r["date"]), size=8), P(r["route"], size=8), P(r["purpose"], size=8), P(str(r["km"]), size=8, align=TA_RIGHT), num(r["claimed"], size=8)])
    for m, lab in (("AUG", "Elokuu"), ("SEP", "Syyskuu")):
        rows.append([P("", size=8), P(f"{lab} yhteensä", size=8, bold=True), "", P(str(mi[m]["km"]), size=8, bold=True, align=TA_RIGHT), num(mi[m]["claimed"], size=8, bold=True)])
    rows.append([P("", size=8), P("HAETAAN YHTEENSÄ", size=8.5, bold=True), "", P(str(mi["km_total"]), size=8.5, bold=True, align=TA_RIGHT), num(mi["claimed_total"], size=8.5, bold=True)])
    story.append(tbl(rows, [20 * mm, 72 * mm, 52 * mm, 12 * mm, 22 * mm], repeat=1, zebra=True))
    story.append(Spacer(1, 4 * mm))
    story.append(P(f"Lisäksi kulukorvaus: käteisostos 27.8.2024, Kuljetus ja Maansiirto T. Hämäläinen, sepelikuorma 120,00 € (kuitti liitteenä).", size=8.5))
    story.append(P(f"Maksetaan yhdellä tilisiirrolla tilille {o['iban']}. Jyväskylä 30.9.2024 — Janne Kivijärvi (hyväksytty: J.K.)", size=8.5))
    build_pdf(path, story, "Ajopäiväkirja 8–9/2024 · J. Kivijärvi")


# ════════════════════════════════════════════════════════════════════════════
# RECEIPTS & ENGLISH INVOICES
# ════════════════════════════════════════════════════════════════════════════
def _receipt_text(pack, q):
    party = S.PARTIES[q["merchant"]]
    pp = pack.parties[q["merchant"]]
    L = []
    L.append(("C", party["name"].upper(), True))
    for a in party.get("address", []):
        L.append(("C", a, False))
    if pp.get("ytunnus"):
        L.append(("C", f"Y-tunnus {pp['ytunnus']}", False))
    L.append(("L", "=" * 34, False))
    L.append(("L", f" {dmy(q['date'])}   klo {q.get('time', '12:00')}", False))
    L.append(("L", "=" * 34, False))
    rate = q["rate"]
    if "fuel" in q:
        name, litres, unit, gross = q["item_lines"][0]
        L.append(("L", f"{name} {litres.replace('.', ',')} L a {unit.replace('.', ',')}", False))
        L.append(("R", f"{fmt(gross)} A", False))
    else:
        for n, qty, pr, amt in q["item_lines"]:
            if qty != "1":
                L.append(("L", n, False))
                L.append(("LR", f"  {qty} x {pr.replace('.', ',')}", f"{fmt(amt)} A"))
            else:
                L.append(("LR", n[:24], f"{fmt(amt)} A"))
    L.append(("L", "-" * 34, False))
    L.append(("LR", "YHTEENSÄ", f"{fmt(q['gross'])} EUR"))
    L.append(("LR", "KORTTI VISA", f"{fmt(q['gross'])} EUR"))
    L.append(("L", "  **** **** **** 4417", False))
    L.append(("L", "  OSTO HYVÄKSYTTY  PIN", False))
    L.append(("L", "=" * 34, False))
    L.append(("L", " ALV-ERITTELY", False))
    L.append(("L", "  ALV%    VEROTON    VERO    YHT.", False))
    rl = rate.replace(".", ",")
    L.append(("L", f"A {rl:>5} {fmt(q['net']):>9} {fmt(q['vat']):>7} {fmt(q['gross']):>8}", False))
    L.append(("L", "=" * 34, False))
    L.append(("C", "KIITOS KÄYNNISTÄ!", False))
    L.append(("C", S.MARK, False))
    return L


def receipt_image(lines, *, seed, width=520, faded=False, lowcontrast=False, font_size=19):
    rng = random.Random(seed)
    mono = ImageFont.truetype(MONO_PFB, font_size)
    monob = ImageFont.truetype(MONO_BOLD_PFB, font_size + 2)
    lh = int(font_size * 1.35)
    h = 40 + lh * len(lines) + 40
    paper = Image.new("L", (width, h), 250)
    d = ImageDraw.Draw(paper)
    ink = 150 if faded else (95 if lowcontrast else 25)
    y = 30
    for ln in lines:
        kind = ln[0]
        if kind == "C":
            text, bold = ln[1], ln[2]
            f = monob if bold else mono
            w = d.textlength(text, font=f)
            d.text(((width - w) / 2, y), text, font=f, fill=ink + (rng.randint(0, 25) if faded else 0))
        elif kind == "L":
            d.text((24, y), ln[1], font=mono, fill=ink + (rng.randint(0, 30) if faded else 0))
        elif kind == "R":
            w = d.textlength(ln[1], font=mono)
            d.text((width - 24 - w, y), ln[1], font=mono, fill=ink)
        elif kind == "LR":
            d.text((24, y), ln[1], font=mono, fill=ink + (rng.randint(0, 30) if faded else 0))
            w = d.textlength(ln[2], font=mono)
            d.text((width - 24 - w, y), ln[2], font=mono, fill=ink)
        y += lh
    # thermal paper grain
    px = paper.load()
    for _ in range(width * h // 18):
        x_, y_ = rng.randrange(width), rng.randrange(h)
        px[x_, y_] = max(0, min(255, px[x_, y_] + rng.randint(-35, 12)))
    if faded:
        # a lighter vertical band where the print head was weak
        band = rng.randrange(width // 3, 2 * width // 3)
        for yy in range(h):
            for xx in range(band - 40, band + 40):
                v = px[xx, yy]
                px[xx, yy] = min(252, v + (252 - v) // 2)
    return paper.filter(ImageFilter.GaussianBlur(0.6))


def photo_of(paper, *, seed, angle, bg=(92, 70, 52), size=None, shadow=True, dark=0, crop=None):
    rng = random.Random(seed)
    rgb = Image.merge("RGB", (paper, paper, paper.point(lambda v: max(0, v - 6)))) if paper.mode == "L" else paper
    W = size[0] if size else rgb.width + 220
    H = size[1] if size else rgb.height + 220
    canvas = Image.new("RGB", (W, H), bg)
    cp = canvas.load()
    for _ in range(W * H // 10):  # wood/table texture noise
        x_, y_ = rng.randrange(W), rng.randrange(H)
        r, g, b = cp[x_, y_]
        k = rng.randint(-18, 18)
        cp[x_, y_] = (max(0, min(255, r + k)), max(0, min(255, g + k)), max(0, min(255, b + k)))
    canvas = canvas.filter(ImageFilter.GaussianBlur(1.2))
    rot = rgb.rotate(angle, resample=Image.BICUBIC, expand=True, fillcolor=(0, 0, 0))
    mask = Image.new("L", rgb.size, 255).rotate(angle, resample=Image.BICUBIC, expand=True, fillcolor=0)
    ox, oy = (W - rot.width) // 2 + rng.randint(-15, 15), (H - rot.height) // 2 + rng.randint(-10, 10)
    if shadow:
        sh = Image.new("RGB", rot.size, (30, 22, 15))
        canvas.paste(sh, (ox + 9, oy + 11), mask.filter(ImageFilter.GaussianBlur(6)))
    canvas.paste(rot, (ox, oy), mask)
    if dark:
        canvas = canvas.point(lambda v: int(v * (1 - dark)))
    # vignette-ish lighting gradient
    grad = Image.linear_gradient("L").resize((W, H)).rotate(rng.choice([0, 90, 180, 270]))
    shade = Image.new("RGB", (W, H), (0, 0, 0))
    canvas = Image.composite(shade, canvas, grad.point(lambda v: int(v * 0.22)))
    if crop:
        canvas = canvas.crop(crop)
    return canvas


def save_jpg(img, path):
    img.save(path, "JPEG", quality=84, optimize=False, progressive=False, subsampling=2)


def image_pdf(path, img, label, note=None):
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=80, optimize=False, progressive=False, subsampling=2)
    buf.seek(0)
    w, h = img.size
    maxw, maxh = 170 * mm, 235 * mm
    sc = min(maxw / w, maxh / h)
    story = [RLImage(buf, width=w * sc, height=h * sc)]
    if note:
        story.insert(0, P(note, size=7, color=GREY))
    build_pdf(path, story, label)


def card_receipt(pack, q, path, *, mode, seed):
    lines = _receipt_text(pack, q)
    if mode == "photo_rotated":
        paper = receipt_image(lines, seed=seed)
        save_jpg(photo_of(paper, seed=seed, angle=-7.5), path)
    elif mode == "photo_lowcontrast":
        paper = receipt_image(lines, seed=seed, lowcontrast=True)
        save_jpg(photo_of(paper, seed=seed, angle=3.2, dark=0.28, bg=(70, 72, 78)), path)
    elif mode == "scan_faded":
        paper = receipt_image(lines, seed=seed, faded=True)
        scan = Image.new("L", (paper.width + 80, paper.height + 80), 238)
        scan.paste(paper, (40, 40))
        image_pdf(path, scan.rotate(1.3, resample=Image.BICUBIC, fillcolor=238).convert("RGB"), f"Skannattu kuitti {dmy(q['date'])}",
                  note="Skannaus: lämpöpaperikuitti (haalistunut)")
    elif mode == "photo_duplicate":
        paper = receipt_image(lines, seed=seed)
        save_jpg(photo_of(paper, seed=seed, angle=-11.0), path[0])
        big = photo_of(paper, seed=seed + 1, angle=1.4, bg=(120, 118, 110))
        save_jpg(big.crop((40, 60, big.width - 30, big.height - 20)), path[1])
    else:
        raise ValueError(mode)


def lunch_receipt(pack, q, path, seed):
    lines = _receipt_text(pack, q)
    paper = receipt_image(lines, seed=seed)
    # handwritten note in blue ink at the bottom (the owner's annotation)
    note_h = 150
    full = Image.new("L", (paper.width, paper.height + note_h), 250)
    full.paste(paper, (0, 0))
    rgb = Image.merge("RGB", (full, full, full))
    d = ImageDraw.Draw(rgb)
    hand = ImageFont.truetype(HAND_PFB, 30)
    rng = random.Random(seed)
    y = paper.height + 8
    for part in ["Neuvottelu As Oy Kotikallio", "hall. pj. R. N.  - edustus / JK"]:
        x = 26
        for ch in part:
            d.text((x, y + rng.randint(-2, 2)), ch, font=hand, fill=(28, 45, 140))
            x += d.textlength(ch, font=hand) + rng.uniform(-0.6, 0.8)
        y += 46
    save_jpg(photo_of(rgb, seed=seed, angle=4.0, bg=(150, 140, 120)), path)


def cash_receipt_image(pack, path, seed):
    cr = pack.cash_receipt
    party = pack.parties[cr["party"]]
    W, H = 900, 560
    img = Image.new("RGB", (W, H), (246, 244, 236))
    d = ImageDraw.Draw(img)
    sans = ImageFont.truetype(SANS_TTF, 20)
    sansb = ImageFont.truetype(SANS_BOLD_TTF, 30)
    small = ImageFont.truetype(SANS_TTF, 14)
    hand = ImageFont.truetype(HAND_PFB, 38)
    d.rectangle((20, 20, W - 20, H - 20), outline=(90, 90, 90), width=3)
    d.text((40, 36), "KUITTI", font=sansb, fill=(40, 40, 40))
    d.text((W - 260, 44), "Nro  0147", font=sans, fill=(40, 40, 40))
    fields = [("Päivämäärä", 110), ("Vastaanotettu", 170), ("Selite", 230), ("", 290), ("Summa €", 350), ("Myyjä / Y-tunnus", 420)]
    for label, yy in fields:
        d.text((40, yy), label, font=sans, fill=(60, 60, 60))
        d.line((240, yy + 30, W - 40, yy + 30), fill=(150, 150, 150), width=1)
    rng = random.Random(seed)

    def write(x, y, text, size=38):
        f = ImageFont.truetype(HAND_PFB, size)
        for ch in text:
            d.text((x, y + rng.randint(-3, 3)), ch, font=f, fill=(20, 40, 150))
            x += d.textlength(ch, font=f) + rng.uniform(-0.5, 1.0)

    write(250, 96, "27.8.2024")
    write(250, 156, "Remonttipalvelu Kivijarvi / Janne")
    write(250, 216, "Sepeli 6-16mm 2 m3 + kuljetus")
    write(250, 276, "Ristikiventie 3 (Rinne)")
    write(250, 336, "120,00 eur  sis. alv 24%")
    write(250, 406, f"T. Hamalainen  {party['ytunnus']}", 34)
    write(560, 470, "Maksettu kateisella  T.H.", 32)
    d.text((40, H - 50), f"{party['name']} · {', '.join(party['address'])}", font=small, fill=(90, 90, 90))
    d.text((W - 300, H - 50), S.MARK, font=small, fill=(150, 150, 150))
    del hand
    photo = photo_of(img, seed=seed, angle=-2.2, bg=(120, 100, 80))
    save_jpg(photo, path)


def parking_email(pack, q, path):
    party = pack.parties["parkkinyt"]
    story = [PR(f"<font color='{ACCENT['parkkinyt'].hexval()}'><b>ParkkiNyt</b></font>", size=16), Spacer(1, 2 * mm),
             P("Kuitti pysäköinnistä", size=11, bold=True), Spacer(1, 3 * mm)]
    rows = [["Päivä", f"{dmy(q['date'])} klo {q['time']}"], ["Kohde", q["item_lines"][0][0]], ["Ajoneuvo", "RKV-248"],
            ["Maksutapa", "Visa •••• 4417"], ["Summa (sis. ALV)", f"{fmt(q['gross'])} €"],
            [f"ALV {q['rate'].replace('.', ',')} %", f"{fmt(q['vat'])} €"], ["Veroton", f"{fmt(q['net'])} €"],
            ["Myyjä", f"{party['name']} · Y-tunnus {party['ytunnus']}"], ["Asiakas", "janne@remonttikivijarvi.example"]]
    story.append(tbl([[P(a, size=9, color=GREY), P(b, size=9.5)] for a, b in rows], [45 * mm, 120 * mm], zebra=True))
    story.append(Spacer(1, 4 * mm))
    story.append(P("Tämä on automaattinen kuitti. Säilytä kuitti kirjanpitoa varten.", size=8, color=GREY))
    build_pdf(path, story, f"ParkkiNyt · kuitti {dmy(q['date'])}")


def sitemeasure_invoice(pack, q, path):
    party = pack.parties["sitemeasure"]
    co = pack.company
    story = [tbl([[PR(f"<font color='{ACCENT['sitemeasure'].hexval()}'><b>SiteMeasure</b></font>", size=18),
                   PR("<b>INVOICE / RECEIPT</b>", size=13, align=TA_RIGHT)]], [110 * mm, 68 * mm]), Spacer(1, 2 * mm),
             P(f"{party['name']} · {', '.join(party['address'])} · billing@sitemeasure.example", size=8, color=GREY), Spacer(1, 5 * mm)]
    meta = [["Invoice no.", q["inv_no"]], ["Date paid", dmy(q["date"]).replace(".", "/")], ["Billing period", q["service_period"]],
            ["Payment method", "Visa •••• 4417"], ["Customer", f"{co['name']} (EU VAT ID {co['vat']})"], ["Billing address", ", ".join(co["address"]) + ", Finland"]]
    story.append(tbl([[P(a, size=8.5, color=GREY), P(b, size=9)] for a, b in meta], [40 * mm, 138 * mm]))
    story.append(Spacer(1, 5 * mm))
    rows = [[P(h, size=8, bold=True) for h in ["DESCRIPTION", "QTY", "UNIT PRICE", "AMOUNT"]],
            [P("SiteMeasure Pro — laser takeoff & site measurement app, monthly subscription (1 seat)", size=9), P("1", size=9), P(f"USD {q['usd']}", size=9), P(f"USD {q['usd']}", size=9)],
            ["", "", P("Subtotal", size=9), P(f"USD {q['usd']}", size=9)], ["", "", P("Sales tax", size=9), P("USD 0.00", size=9)],
            ["", "", P("Total paid", size=9.5, bold=True), P(f"USD {q['usd']}", size=9.5, bold=True)]]
    story.append(tbl(rows, [100 * mm, 14 * mm, 32 * mm, 32 * mm], repeat=1))
    story.append(Spacer(1, 5 * mm))
    story.append(P("Thank you for your business. All amounts in US dollars. SiteMeasure Inc. is not registered for VAT in the European Union.", size=8, color=GREY))
    build_pdf(path, story, f"SiteMeasure Inc. · {q['inv_no']}")
