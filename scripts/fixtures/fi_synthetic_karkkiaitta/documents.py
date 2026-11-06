"""Renders every source document of the pack from the computed Model."""

from __future__ import annotations

import random
from collections import defaultdict
from decimal import Decimal

from . import data as D
from .layout import GREY, LIGHT, MID, SYN, Doc, colors, de, en, fdate, fi, mm
from .model import ZERO, m, month_of, pct, rate_key, vat_from_gross, vat_from_net

CO = D.COMPANY


def rk(rate) -> str:
    """'25.5' -> '25,5'"""
    return rate_key(rate).replace(".", ",")


def prod(p):
    return D.PRODUCTS[p]["name"]


def dm(iso):
    return f"{int(iso[8:10])}.{int(iso[5:7])}."


# --------------------------------------------------------------------------
# Generic Finnish invoice
# --------------------------------------------------------------------------

def fi_invoice(path, title, seller, buyer_lines, meta, headers, rows, widths, aligns, totals, notes=(),
               band_color=colors.Color(0.2, 0.2, 0.2), heading="LASKU", pay_lines=None):
    doc = Doc(path, title)
    doc.c.setFillColor(band_color)
    doc.c.rect(0, doc.H - 10 * mm, doc.W, 10 * mm, stroke=0, fill=1)
    doc.c.setFillColor(colors.black)
    doc.y = doc.H - 16 * mm
    doc.text(seller["name"], 14, bold=True)
    for ln in seller.get("lines", []):
        doc.text(ln, 8, color=GREY, lead=10)
    doc.space(4)
    y_top = doc.y
    doc.at(doc.x1, y_top + 30, heading, 18, bold=True, align="right")

    def left(x, w):
        doc.text("Laskutettava / Bill to", 7, color=GREY, x=x)
        doc.lines_at(x, buyer_lines, size=9, bold_first=True)

    def right(x, w):
        doc.kv(meta, x=x, width=w, size=8.5, keyw=w * 0.46)

    doc.two_col(left, right, 0.52)
    doc.space(8)
    doc.table(headers, rows, widths, aligns)
    doc.space(2)
    for label, val, bold in totals:
        doc.need(12)
        doc.at(doc.x1 - 150, doc.y - 9, label, 8.5, bold=bold)
        doc.at(doc.x1, doc.y - 9, val, 8.5, bold=bold, align="right")
        doc.y -= 12
    doc.space(6)
    for n in notes:
        doc.para(n, 7.8, color=colors.Color(0.2, 0.2, 0.2))
        doc.space(2)
    if pay_lines:
        doc.space(6)
        doc.hr()
        for ln in pay_lines:
            doc.text(ln, 8, lead=11)
    doc.save()


def vat_summary(rows, key_rate="rate", key_net="net", key_vat="vat"):
    by = defaultdict(lambda: [ZERO, ZERO])
    for r in rows:
        by[r[key_rate]][0] += r[key_net]
        by[r[key_rate]][1] += r[key_vat]
    return sorted(by.items(), key=lambda kv: -pct(kv[0]))


# --------------------------------------------------------------------------
# Bank statements
# --------------------------------------------------------------------------

def bank_statement(path, M, month, no):
    lines = M.bank[month]
    first = lines[0].balance - lines[0].amount
    y, mo = month.split("-")
    last_day = {"2024-12": "31.12.2024", "2025-01": "31.01.2025"}[month]
    doc = Doc(path, f"Tiliote {mo}/{y}", landscape_=True, margin=12 * mm)
    c = doc.c
    c.setFillColor(colors.Color(0.05, 0.32, 0.42))
    c.rect(doc.x0, doc.y - 26, 26, 26, stroke=0, fill=1)
    c.setFillColor(colors.white)
    c.setFont("Helvetica-Bold", 15)
    c.drawCentredString(doc.x0 + 13, doc.y - 19, "M")
    c.setFillColor(colors.black)
    doc.at(doc.x0 + 34, doc.y - 12, "MERITUULI PANKKI", 13, bold=True)
    doc.at(doc.x0 + 34, doc.y - 24, "Merituuli Pankki Oyj · BIC MERTFIHH", 7.5, color=GREY)
    doc.at(doc.x1, doc.y - 12, "TILIOTE / KONTOUTDRAG", 13, bold=True, align="right")
    doc.at(doc.x1, doc.y - 24, f"Tiliote nro {no}/{y} · sivu-numerointi alalaidassa", 7.5, color=GREY, align="right")
    doc.y -= 36
    w = (doc.x1 - doc.x0) / 4
    info = [("TILINOMISTAJA", CO["name"]), ("Y-TUNNUS", CO["ytunnus"]), ("TILI (IBAN)", CO["iban_display"]),
            ("KAUSI", f"01.{mo}.{y} – {last_day}")]
    for i, (k, v) in enumerate(info):
        doc.box(doc.x0 + i * w, doc.y - 26, w - 4, 26, fill=LIGHT)
        doc.at(doc.x0 + i * w + 5, doc.y - 9, k, 6.5, color=GREY)
        doc.at(doc.x0 + i * w + 5, doc.y - 21, v, 9, bold=True)
    doc.y -= 34
    rows = [["", "", "ALKUSALDO", "", "", "", fi(first)]]
    for bl in lines:
        rows.append([fdate(bl.date), bl.kind, bl.party, bl.message, bl.archive, fi(bl.amount, plus=True), fi(bl.balance)])
    ins = sum((bl.amount for bl in lines if bl.amount > 0), ZERO)
    outs = sum((bl.amount for bl in lines if bl.amount < 0), ZERO)
    doc.table(["KIRJAUSPVM", "TAPAHTUMA", "SAAJA / MAKSAJA", "VIESTI / VIITE", "ARKISTOINTITUNNUS", "MÄÄRÄ EUR", "SALDO EUR"],
              rows, [0.08, 0.12, 0.2, 0.25, 0.13, 0.11, 0.11],
              ["left", "left", "left", "left", "left", "right", "right"], size=7.3, zebra=True)
    doc.space(4)
    summ = [("Alkusaldo", fi(first)), (f"Panot ({sum(1 for b in lines if b.amount > 0)} kpl)", fi(ins, plus=True)),
            (f"Otot ({sum(1 for b in lines if b.amount < 0)} kpl)", fi(outs)), ("Loppusaldo " + last_day, fi(lines[-1].balance))]
    for k, v in summ:
        doc.need(12)
        doc.at(doc.x1 - 200, doc.y - 9, k, 8.5, bold=k.startswith("Loppu"))
        doc.at(doc.x1, doc.y - 9, v, 8.5, bold=k.startswith("Loppu"), align="right")
        doc.y -= 12
    doc.space(6)
    doc.para("Tilitapahtumat on kirjattu kirjauspäivän mukaan. Korttiostot näkyvät yrityskortin kuukausilaskulla, eivät tällä "
             "tiliotteella. Ulkomaanmaksujen kurssi ja palvelumaksu on eritelty viestikentässä.", 7, color=GREY)
    doc.save()


# --------------------------------------------------------------------------
# Opening trial balance
# --------------------------------------------------------------------------

def opening_tb(path, M):
    from .model import ACCOUNTS
    doc = Doc(path, "Saldoluettelo 30.11.2024")
    doc.text("Tilitoimisto Pohjantähti Oy (edellinen kirjanpitäjä)", 8, color=GREY)
    doc.text("SALDOLUETTELO 30.11.2024", 15, bold=True)
    doc.text(f"{CO['name']} · {CO['ytunnus']} · tilikausi 1.1.–31.12.2024 · kirjanpito suoriteperusteinen, "
             "ALV-kausi kuukausi", 8.5)
    doc.space(4)
    doc.para("Luovutettu uudelle kirjanpitäjälle 2.12.2024. Marraskuu on kirjattu ja ALV 11/2024 ilmoitettu. "
             "Avoimet erät on eritelty alla. Varasto on marraskuun lopun kirjanpitoarvo (viimeisin inventaario 31.12.2023, "
             "väliajan muutokset laskennallisia).", 8.5)
    doc.space(4)
    rows = []
    for a, v in M.opening.items():
        rows.append([a, ACCOUNTS[a], fi(v) if v > 0 else "", fi(-v) if v < 0 else ""])
    rows.append(["", "YHTEENSÄ", fi(sum((v for v in M.opening.values() if v > 0), ZERO)),
                 fi(-sum((v for v in M.opening.values() if v < 0), ZERO))])
    doc.table(["TILI", "NIMI", "DEBET", "KREDIT"], rows, [0.1, 0.56, 0.17, 0.17], ["left", "left", "right", "right"],
              bold_rows=(len(rows) - 1,))
    doc.space(6)
    doc.text("AVOIMIEN ERIEN ERITTELY", 10, bold=True)
    for acct, items in M.docs["opening_detail"].items():
        for txt, v in items:
            doc.table(None, [[acct, txt, fi(v)]], [0.1, 0.73, 0.17], ["left", "left", "right"], size=7.8)
            doc.y += 4
    doc.space(8)
    doc.para("Huom: osakkaat (Liisa Kärkkäinen, Tuomas Rautio, 50 % / 50 %) eivät nosta palkkaa; molemmilla on oma "
             "YEL-vakuutus Elossa, jonka he maksavat itse. Pakkaaja Veera Nieminen aloitti 25.11.2024 "
             "määräaikaisessa työsuhteessa (päättyy 31.1.2025), tuntipalkka 13,50 €.", 8)
    doc.save()


# --------------------------------------------------------------------------
# Card invoices
# --------------------------------------------------------------------------

def card_invoice(path, M, month):
    card = M.docs["card"][month]
    y, mo = month.split("-")
    nxt = {"2024-12": "10.01.2025", "2025-01": "10.02.2025"}[month]
    doc = Doc(path, f"Yrityskortin lasku {mo}/{y}")
    doc.band("MERITUULI BUSINESS MASTERCARD", 12, fill=colors.Color(0.05, 0.32, 0.42))
    doc.kv([("Kortinhaltija", f"{CO['name']} / Liisa Kärkkäinen"), ("Kortti", f"**** **** **** {D.CARD['last4']}"),
            ("Laskutuskausi", f"01.{mo}.{y}–{'31' if mo in ('12', '01') else '30'}.{mo}.{y}"),
            ("Eräpäivä / suoraveloitus", nxt + f" tililtä {CO['iban_display']}")], size=8.5)
    doc.space(6)
    rows = []
    for t in card["txns"]:
        date, merch, desc, eur, orig, kind = t
        o = f"{orig[1]} {orig[0]}" if orig else ""
        rate = ""
        if orig:
            rate = f"{(pct(orig[1]) / pct(eur)).quantize(Decimal('0.0001'))}"
        rows.append([fdate(date), merch, o, rate, fi(m(eur))])
    rows.append(["", "LASKUN LOPPUSUMMA", "", "", fi(card["total"])])
    doc.table(["OSTOPVM", "KAUPPIAS", "ALKUP. VALUUTTA", "KURSSI*", "EUR"], rows, [0.13, 0.43, 0.16, 0.12, 0.16],
              ["left", "left", "right", "right", "right"], bold_rows=(len(rows) - 1,), zebra=True)
    doc.para("* Kurssi sisältää Mastercardin muuntokurssin ja Merituulen valuuttakurssilisän 1,5 %. "
             "Kortin ostot veloitetaan kerran kuukaudessa yhdellä veloituksella yrityksen tililtä.", 7, color=GREY)
    doc.save()


# --------------------------------------------------------------------------
# Web shop sales report (Shopify-style export, English)
# --------------------------------------------------------------------------

def web_report(path, M, month):
    web = M.docs["web"][month]
    pr = web["priced"]
    sp = M.docs["web_split"][month]
    ym = {"2024-12": "December 2024", "2025-01": "January 2025"}[month]
    doc = Doc(path, f"Sales report {month}")
    doc.band("karkkiaitta.example · Store analytics", 10, fill=colors.Color(0.37, 0.55, 0.24))
    doc.text(f"Sales by product and tax rate — {ym}", 14, bold=True)
    doc.text("Filter: fulfilled in period · shipping country = Finland · export generated by store owner", 8, color=GREY)
    doc.space(4)
    rows = []
    fix = D.WEB_TAX_SETTING_FIX
    for r in pr["rows"]:
        label = r["label"]
        tax_rate = r["rate"]
        if month == "2025-01" and r["cat"] == "book" and r["product"] in fix["before_qty"]:
            # split into the rows the store actually exported
            before_q = fix["before_qty"][r["product"]]
            unit_g = r["gross"] / r["qty"]
            g_before = m(unit_g * before_q)
            g_after = r["gross"] - g_before
            v_b = vat_from_gross(g_before, "10")
            v_a = vat_from_gross(g_after, "14")
            rows.append([label + f" (1–8 Jan)", before_q, en(g_before), "10 % (store setting)", en(g_before - v_b), en(v_b)])
            rows.append([label + f" (9–31 Jan)", r["qty"] - before_q, en(g_after), "14 %", en(g_after - v_a), en(v_a)])
            continue
        rows.append([label, r["qty"], en(r["gross"]), f"{rk(tax_rate)} %", en(r["net"]), en(r["vat"])])
    doc.table(["PRODUCT / COMPONENT", "QTY", "GROSS SALES EUR", "TAX RATE", "NET EUR", "TAX EUR"], rows,
              [0.42, 0.07, 0.14, 0.15, 0.11, 0.11], ["left", "right", "right", "left", "right", "right"], zebra=True, size=7.4)
    doc.para("Gift box 'Joulun Makea Lahjalaatikko' (59.90) is exported as three tax components, split by component "
             "purchase cost (chocolate 5.40 / book 11.20 / mug 4.10). Sales are exported per fulfilment date.", 7, color=GREY)
    doc.space(4)
    doc.text("Shipping charged to customers", 10, bold=True)
    srows = [[D.SHIPPING[k]["name"], n, en(m(pct(D.SHIPPING[k]["price"]) * n))] for k, n in D.WEB_BULK[month]["ship"].items()]
    srows.append(["Total shipping", "", en(web["ship_gross"])])
    doc.table(["METHOD", "ORDERS", "GROSS EUR"], srows, [0.5, 0.2, 0.3], ["left", "right", "right"], bold_rows=(len(srows) - 1,))
    arows = [[f"{rk(r['rate'])} %", en(r["gross"]), en(r["net"]), en(r["vat"])] for r in pr["ship"]]
    doc.text("Shipping tax allocation (store setting: follow the goods, split by net value of the goods per rate)", 7.5, color=GREY)
    doc.table(["RATE", "GROSS", "NET", "TAX"], arows, [0.25, 0.25, 0.25, 0.25], ["left", "right", "right", "right"], size=7.4)
    doc.space(4)
    doc.text("Payments", 10, bold=True)
    prow = [["Paytrail (cards, bank buttons, MobilePay-in-Paytrail)", en(sp["paytrail"])],
            ["Klarna (pay later / invoice)", en(sp["klarna"])],
            ["Gift card redemptions", en(sp["giftcard"])],
            ["Total (= gross sales incl. shipping above)", en(pr["gross"])]]
    doc.table(["METHOD", "GROSS EUR"], prow, [0.7, 0.3], ["left", "right"], bold_rows=(3,))
    doc.space(4)
    if month == "2024-12":
        doc.text("Orders paid in December, not yet fulfilled (excluded above)", 10, bold=True)
        orows = []
        for a in M.docs["advance"]:
            o = a["order"]
            items = ", ".join(f"{q} x {prod(p)}" for p, q in o["lines"])
            orows.append([o["id"], fdate(o["paid"], "en"), "Paytrail", items, en(a["priced"]["gross"])])
        ko = M.docs["klarna_special"]
        o = ko["order"]
        orows.append([o["id"], fdate(o["ordered"], "en") + " (ordered)", "Klarna — authorised, not captured",
                      ", ".join(f"{q} x {prod(p)}" for p, q in o["lines"]), en(ko["priced"]["gross"])])
        doc.table(["ORDER", "PAID", "METHOD", "ITEMS", "GROSS EUR"], orows, [0.13, 0.17, 0.22, 0.36, 0.12],
                  ["left", "left", "left", "left", "right"], size=7.3)
        doc.text("Gift cards issued (online)", 10, bold=True)
        grows = [[fdate(dd, "en"), en(m(a))] for dd, a in D.GIFTCARDS_SOLD_WEB]
        grows.append(["Total issued online", en(sum((m(a) for _, a in D.GIFTCARDS_SOLD_WEB), ZERO))])
        doc.table(["DATE", "AMOUNT EUR (paid via Paytrail)"], grows, [0.5, 0.5], ["left", "right"], bold_rows=(len(grows) - 1,))
    else:
        doc.text("Also fulfilled in January (not in the table above)", 10, bold=True)
        orows = []
        for a in M.docs["advance"]:
            o = a["order"]
            orows.append([o["id"], fdate(o["paid"], "en"), fdate(o["shipped"], "en"), "Paytrail (paid in Dec)",
                          ", ".join(f"{q} x {prod(p)}" for p, q in o["lines"]), en(a["priced"]["gross"])])
        ko = M.docs["klarna_special"]
        o = ko["order"]
        orows.append([o["id"], fdate(o["ordered"], "en"), fdate(o["shipped"], "en"), "Klarna (captured on fulfilment)",
                      ", ".join(f"{q} x {prod(p)}" for p, q in o["lines"]), en(ko["priced"]["gross"])])
        doc.table(["ORDER", "ORDERED/PAID", "FULFILLED", "PAYMENT", "ITEMS", "GROSS"], orows,
                  [0.12, 0.14, 0.13, 0.19, 0.31, 0.11], ["left", "left", "left", "left", "left", "right"], size=7.2)
        doc.text("Refunds issued in January (via Paytrail)", 10, bold=True)
        rrows = []
        for r in M.docs["refunds"]:
            ret = r["ret"]
            rrows.append([ret["id"], fdate(ret["order_date"], "en"), fdate(ret["refund_date"], "en"), ret["cc"],
                          "Return (14-day right)" if ret["kind"] == "return" else "Lost in transit", en(r["priced"]["gross"])])
        doc.table(["ORDER", "ORDERED", "REFUNDED", "COUNTRY", "REASON", "AMOUNT EUR"], rrows,
                  [0.14, 0.15, 0.15, 0.1, 0.3, 0.16], ["left", "left", "left", "left", "left", "right"], size=7.3)
        doc.para(f"Tax settings changed on {fdate(fix['date'], 'en')}: category 'Books' 10 % -> 14 %. "
                 "Orders fulfilled 1–8 January were taxed with the old store setting.", 7.5, color=colors.Color(0.6, 0.1, 0.1))
    doc.save()


# --------------------------------------------------------------------------
# EU distance sales export
# --------------------------------------------------------------------------

def eu_export(path, M):
    doc = Doc(path, "EU distance sales export", landscape_=True, margin=12 * mm)
    doc.band("EU consumer sales (distance sales) — web shop + Amazon.de · export 2025-02-03", 10,
             fill=colors.Color(0.37, 0.55, 0.24))
    doc.para(f"Calendar year 2024 EU distance sales to consumers before December (net, both channels): "
             f"EUR {en(pct(D.EU_DISTANCE_SALES_2024_JAN_NOV))}. 2023 total: EUR {en(pct(D.EU_DISTANCE_SALES_2023))}. "
             "Store tax setting until OSS registration: Finnish VAT on all EU orders. 'Store tax' below is the country whose "
             "VAT the store applied; the column 'Cumulative 2024 net' is computed by the store owner's spreadsheet.", 8)
    doc.space(3)
    rows = []
    for e in M.docs["eu_orders"]:
        o, pr = e["order"], e["priced"]
        items = ", ".join(f"{q}x {p}" for p, q in o["lines"])
        store_tax = "FI" if o["date"] < D.TAX["oss_registered"] else o["cc"]
        rows.append([o["id"], fdate(o["date"]), "Amazon.de" if o["ch"] == "amazon" else "Web", o["cc"], items,
                     en(pr["gross"]), store_tax, en(e["cum_after"]) if e["cum_after"] is not None else "2025"])
    doc.table(["ORDER", "DATE", "CHANNEL", "SHIP TO", "ITEMS (SKU)", "GROSS EUR", "STORE TAX", "CUMULATIVE 2024 NET"],
              rows, [0.11, 0.09, 0.09, 0.07, 0.3, 0.11, 0.09, 0.14],
              ["left", "left", "left", "left", "left", "right", "left", "right"], size=7.2, zebra=True)
    doc.para("SKU key: K1 salmiakki, K2 chocolate box, K3 advent calendar (chocolate), K4 liquorice, K5 cream toffee, "
             "J1 cranberry lemonade, B1/B2 books, M1 mug, G1 gift box (chocolate + book + mug). Shipping: web EU 12.90, "
             "Amazon 4.99 per order, included in gross.", 7, color=GREY)
    doc.para(f"OSS (union scheme) registration filed in OmaVero on {fdate(D.TAX['oss_registered'])}; store tax setting "
             "switched to destination-country rates on the same day.", 7.5)
    doc.save()


# --------------------------------------------------------------------------
# Paytrail
# --------------------------------------------------------------------------

def paytrail_report(path, M, month):
    y, mo = month.split("-")
    doc = Doc(path, f"Paytrail tilitysraportti {mo}/{y}")
    doc.band("Paytrail · Tilitysraportti", 11, fill=colors.Color(0.55, 0.1, 0.35))
    doc.kv([("Kauppias", f"{CO['name']} ({CO['ytunnus']})"), ("Kauppiastunnus", D.PAYTRAIL["merchant_id"]),
            ("Raportin kausi", f"tilitykset {mo}/{y}"), ("Tilitystili", CO["iban_display"]),
            ("Palvelumaksu", f"{D.PAYTRAIL['fee_pct'].replace('.', ',')} % maksujen bruttomäärästä (AVL 41 §, veroton)")])
    doc.space(4)
    daily = M.docs["paytrail_daily"]
    for s in M.docs["paytrail_settlements"]:
        if month_of(s["date"]) != month:
            continue
        doc.text(f"Tilitys {fdate(s['date'])} · maksut {fdate(s['from'])}–{fdate(s['to'])}", 9.5, bold=True)
        rows = []
        for dd in s["days"]:
            v = daily[dd]
            n = max(1, int((v["total"] / Decimal("37.5")).to_integral_value())) if v["total"] else 0
            rows.append([fdate(dd), n, fi(v["total"])])
        doc.table(["MAKSUPÄIVÄ", "MAKSUJA KPL", "BRUTTO EUR"], rows, [0.4, 0.25, 0.35], ["left", "right", "right"], size=7.3)
        trows = [["Maksut brutto", fi(s["gross"])], [f"Palvelumaksu {D.PAYTRAIL['fee_pct'].replace('.', ',')} %", fi(-s["fee"])]]
        for r in s["refunds"]:
            trows.append([f"Hyvitys asiakkaalle, tilaus {r['ret']['id']} ({fdate(r['ret']['refund_date'])})", fi(-r["priced"]["gross"])])
        if s["cb"]:
            cb = M.docs["chargeback"]["cb"]
            trows.append([f"Takaisinveloitus (chargeback), tilaus {cb['order']} ({fdate(cb['order_date'])})", fi(-s["cb"])])
            trows.append(["Takaisinveloituksen käsittelymaksu", fi(-s["cb_fee"])])
        trows.append(["TILITETTY NETTO", fi(s["net"])])
        doc.table(None, trows, [0.7, 0.3], ["left", "right"], bold_rows=(len(trows) - 1,), size=7.8)
        doc.space(3)
    doc.para("Tilitys sisältää kaikki Paytrailin kautta välitetyt maksut (verkkopankit, kortit, MobilePay-maksutapa "
             "verkkokaupassa) sekä verkkokaupassa myydyt lahjakortit. Palautukset ja takaisinveloitukset vähennetään "
             "seuraavasta tilityksestä.", 7, color=GREY)
    doc.save()


def paytrail_hold_email(path, M):
    s = next(x for x in M.docs["paytrail_settlements"] if x["reserve"])
    doc = Doc(path, "Paytrail - tilityksen pidätys")
    doc.text("Sähköposti", 8, color=GREY)
    doc.kv([("Lähettäjä", "Paytrail Riskienhallinta <risk@paytrail.example>"), ("Vastaanottaja", "liisa@karkkiaitta.example"),
            ("Päivämäärä", "23.12.2024 klo 07.42"), ("Aihe", f"Tilityksen osittainen pidätys – kauppiastunnus {D.PAYTRAIL['merchant_id']}")])
    doc.hr()
    doc.para("Hei,\n\nkauppiaanne maksuvolyymi on joulukuussa kasvanut yli kolminkertaiseksi tavanomaiseen verrattuna. "
             "Riskienhallintakäytäntömme mukaisesti olemme pidättäneet tämän päivän tilityksestä "
             f"{fi(s['reserve'])} euroa vakuudeksi mahdollisia palautuksia ja takaisinveloituksia varten.\n\n"
             f"Tilitysraportin mukainen netto on {fi(s['net'])} euroa; tilillenne maksetaan tänään {fi(s['paid'])} euroa. "
             f"Pidätetty summa vapautetaan kokonaisuudessaan {fdate(D.PAYTRAIL['reserve']['released_on'])}, jos poikkeuksellisia "
             "palautuksia ei ilmene. Pidätys ei näy tilitysraportilla erillisenä rivinä.\n\nYstävällisin terveisin\n"
             "Paytrail Oyj / Riskienhallinta", 9)
    doc.save()


# --------------------------------------------------------------------------
# Klarna (English)
# --------------------------------------------------------------------------

def klarna_report(path, M, month):
    ym = {"2024-12": "December 2024", "2025-01": "January 2025"}[month]
    doc = Doc(path, f"Klarna settlement report {month}")
    doc.band("Klarna · Settlement report", 11, fill=colors.Color(1.0, 0.70, 0.78), color=colors.black)
    doc.kv([("Merchant", f"{CO['name']} · MID {D.KLARNA['merchant_id']}"), ("Period", f"payouts in {ym}"),
            ("Pricing", f"{D.KLARNA['fee_pct']} % of captured amount (financial service, no VAT)"),
            ("Payout account", CO["iban_display"])])
    daily = M.docs["klarna_daily"]
    for k in M.docs["klarna_payouts"]:
        if month_of(k["date"]) != month:
            continue
        doc.space(3)
        doc.text(f"Payout {fdate(k['date'], 'en')} — captures {fdate(k['from'], 'en')} to {fdate(k['to'], 'en')}", 9.5, bold=True)
        rows = [[fdate(dd, "iso"), en(daily[dd])] for dd in k["days"] if daily[dd]]
        rows += [["Captured total", en(k["gross"])], [f"Klarna fee {D.KLARNA['fee_pct']} %", en(-k["fee"])], ["Payout", en(k["net"])]]
        doc.table(["CAPTURE DATE", "AMOUNT EUR"], rows, [0.6, 0.4], ["left", "right"], bold_rows=(len(rows) - 1,), size=7.3)
    doc.para("Klarna pays the merchant for an order when the order is captured (on fulfilment), not when the customer "
             "places it.", 7, color=GREY)
    doc.save()


# --------------------------------------------------------------------------
# Pop-up market: Nexi, MobilePay, Z-report
# --------------------------------------------------------------------------

def nexi_report(path, M):
    pu = M.docs["popup"]
    doc = Doc(path, "Nexi tilitysraportti joulutori")
    doc.band("Nexi · Korttimaksujen tilitysraportti", 11, fill=colors.Color(0.1, 0.1, 0.35))
    doc.kv([("Kauppias", CO["name"]), ("Myyntipaikka", D.POPUP["name"] + " (maksupääte TID 88120451)"),
            ("Palvelumaksu", f"{D.POPUP['nexi_fee_pct'].replace('.', ',')} % (veroton rahoituspalvelu)")])
    doc.space(4)
    rows = []
    for p_ in pu["payouts"]:
        for dd in p_["days"]:
            day = next(x for x in pu["days"] if x["day"] == dd)
            rows.append([fdate(dd), fi(day["card"]), "", "", ""])
        rows.append([f"Tilitys {fdate(p_['date'])}", fi(p_["card"]), fi(-p_["card_fee"]), fi(p_["card"] - p_["card_fee"]), fdate(p_["date"])])
    doc.table(["MYYNTIPÄIVÄ / TILITYS", "BRUTTO EUR", "PALVELUMAKSU", "NETTO EUR", "TILILLÄ"], rows,
              [0.3, 0.17, 0.17, 0.17, 0.19], ["left", "right", "right", "right", "left"], size=7.6,
              bold_rows=tuple(i for i, r in enumerate(rows) if r[0].startswith("Tilitys")))
    doc.save()


def mobilepay_report(path, M):
    pu = M.docs["popup"]
    doc = Doc(path, "MobilePay tilitysraportti")
    doc.band("MobilePay · Myyntipaikka-raportti", 11, fill=colors.Color(0.35, 0.47, 0.95))
    doc.kv([("Yritys", CO["name"]), ("Myyntipaikka", "Karkkiaitta joulutori (QR)"),
            ("Palvelumaksu", f"{D.POPUP['mobilepay_fee_pct'].replace('.', ',')} % tapahtumista")])
    doc.space(4)
    rows = []
    for p_ in pu["payouts"]:
        days = ", ".join(fdate(dd) for dd in p_["days"])
        rows.append([days, fi(p_["mp"]), fi(-p_["mp_fee"]), fi(p_["mp"] - p_["mp_fee"]), fdate(p_["date"])])
    tot = [sum((p_[k] for p_ in pu["payouts"]), ZERO) for k in ("mp", "mp_fee")]
    rows.append(["Yhteensä", fi(tot[0]), fi(-tot[1]), fi(tot[0] - tot[1]), ""])
    doc.table(["MAKSUPÄIVÄT", "MAKSUT EUR", "PALVELUMAKSU", "SIIRTO EUR", "SIIRTOPÄIVÄ"], rows,
              [0.34, 0.16, 0.16, 0.16, 0.18], ["left", "right", "right", "right", "left"], bold_rows=(len(rows) - 1,))
    doc.save()


def z_report(path, M):
    pu = M.docs["popup"]
    pr = pu["priced"]
    doc = Doc(path, "Kassan Z-raportti joulutori", margin=14 * mm)
    doc.font = "Courier"
    doc.bold = "Courier-Bold"
    doc.text("KARKKIAITTA OY – KASSAJÄRJESTELMÄ", 10, bold=True, align="center")
    doc.text(f"{D.POPUP['name'].upper()}", 9, align="center")
    doc.text("Z-RAPORTTI JAKSO 13.12.2024–22.12.2024", 9, align="center")
    doc.hr()
    rows = [[r["label"][:44], r["qty"], fi(r["gross"]), f"{rk(r['rate'])}%"] for r in pr["rows"]]
    doc.table(["TUOTE", "KPL", "BRUTTO", "ALV"], rows, [0.6, 0.1, 0.18, 0.12], ["left", "right", "right", "right"],
              size=7.5, font="Courier")
    by = vat_summary(pr["rows"])
    doc.text("ALV-ERITTELY", 9, bold=True)
    vrows = [[f"{rk(rt)} %", fi(n), fi(v), fi(n + v)] for rt, (n, v) in by]
    vrows.append(["YHT.", fi(pr["net"]), fi(pr["vat"]), fi(pr["gross"])])
    doc.table(["KANTA", "VEROTON", "VERO", "BRUTTO"], vrows, [0.25, 0.25, 0.25, 0.25], ["left", "right", "right", "right"],
              size=7.8, font="Courier", bold_rows=(len(vrows) - 1,))
    doc.text("MAKSUTAVAT PÄIVITTÄIN", 9, bold=True)
    drows = [[fdate(x["day"]), fi(x["card"]), fi(x["mp"]), fi(x["total"])] for x in pu["days"]]
    drows.append(["YHT.", fi(sum((x["card"] for x in pu["days"]), ZERO)), fi(sum((x["mp"] for x in pu["days"]), ZERO)), fi(pr["gross"])])
    doc.table(["PÄIVÄ", "KORTTI", "MOBILEPAY", "YHT."], drows, [0.25, 0.25, 0.25, 0.25], ["left", "right", "right", "right"],
              size=7.8, font="Courier", bold_rows=(len(drows) - 1,))
    doc.text("KÄTEINEN 0,00 – KOJULLA EI KÄTEISKASSAA", 8)
    doc.text("Lahjalaatikko hinnoiteltu osina (suklaa / kirja / muki).", 7.5)
    doc.save()


# --------------------------------------------------------------------------
# Amazon
# --------------------------------------------------------------------------

AMZ_TITLES = {
    "de": {"K1": "Salmiak-Mischung 500 g", "K2": "Pralinenmischung 400 g", "K3": "Adventskalender Vollmilch 24 Türchen",
           "K5": "Sahne-Toffee 200 g", "B2": "Buch: Karkkikeittiö – finnische Süßigkeiten (finn.)", "M1": "Tasse Karkkiaitta 300 ml"},
    "en": {"K1": "Salty liquorice mix 500 g", "K2": "Chocolate assortment 400 g", "K3": "Advent calendar milk chocolate",
           "K5": "Cream toffee 200 g", "B2": "Book: Karkkikeittiö (Finnish)", "M1": "Karkkiaitta mug 300 ml"},
}


def amazon_settlement(path, M, month, lang):
    am = M.docs["amazon"]
    doc = Doc(path, f"Amazon settlement {month}")
    L = {"de": {"title": "Abrechnung", "period": "Abrechnungszeitraum", "date": "DATUM", "order": "BESTELLNUMMER",
                "item": "ARTIKEL", "sales": "UMSATZ INKL. USt", "ship": "VERSAND", "fee": "VERKAUFSGEB.", "total": "BETRAG",
                "sub": "Grundgebühr Verkaufen (Professional)", "ads": "Werbekosten (Sponsored Products)",
                "payout": "Auszahlung", "to": "Überweisung auf Konto endet auf 8025 am",
                "note": "Der Verkäufer ist für die Umsatzsteuer auf seine Verkäufe verantwortlich (kein Marktplatz als "
                        "fiktiver Lieferer: Verkäufer in der EU ansässig). Gebühren werden separat von Amazon Services "
                        "Europe S.à r.l. in Rechnung gestellt.", "fmt": de, "dfmt": "de"},
         "en": {"title": "Settlement", "period": "Settlement period", "date": "DATE", "order": "ORDER ID", "item": "ITEM",
                "sales": "SALES INCL. VAT", "ship": "SHIPPING", "fee": "REFERRAL FEE", "total": "AMOUNT",
                "sub": "Professional selling plan", "ads": "Advertising (Sponsored Products)", "payout": "Payout",
                "to": "Transfer to account ending 8025 on", "note": "Seller is responsible for VAT on its sales. Fees are "
                "invoiced separately by Amazon Services Europe S.à r.l.", "fmt": en, "dfmt": "en"}}[lang]
    f = L["fmt"]
    doc.band(f"amazon seller central · {L['title']}", 11, fill=colors.Color(0.14, 0.18, 0.24))
    doc.text(f"{CO['name']} · Marketplace Amazon.de · Seller ID A2KRK8TT00FI", 8.5)
    for s in am["settlements"]:
        if month_of(s["paid"]) != month:
            continue
        doc.space(4)
        doc.text(f"{L['period']}: {fdate(s['from'], L['dfmt'])} – {fdate(s['to'], L['dfmt'])}", 9.5, bold=True)
        rows = []
        for e in s["orders"]:
            o, pr = e["order"], e["priced"]
            goods = sum((r["gross"] for r in pr["rows"]), ZERO)
            ship = sum((r["gross"] for r in pr["ship"]), ZERO)
            fee = next(x[2] for x in s["fees"] if x[3] == o["id"])
            items = ", ".join(f"{q}x {AMZ_TITLES[lang][p]}" for p, q in o["lines"])
            rows.append([fdate(o["date"], L["dfmt"]), o["id"], items, f(goods), f(ship), f(-fee), f(goods + ship - fee)])
        for x in s["fees"]:
            if x[1] == "subscription":
                rows.append([fdate(x[0], L["dfmt"]), "", L["sub"], "", "", "", f(-x[2])])
            if x[1] == "ads":
                rows.append([fdate(x[0], L["dfmt"]), "", L["ads"], "", "", "", f(-x[2])])
        g_tot = sum((sum((r["gross"] for r in e["priced"]["rows"]), ZERO) for e in s["orders"]), ZERO)
        rows.append(["", "", L["payout"], f(g_tot), f(s["sales"] - g_tot), f(-s["fee_total"]), f(s["net"])])
        doc.table([L["date"], L["order"], L["item"], L["sales"], L["ship"], L["fee"], L["total"]], rows,
                  [0.1, 0.13, 0.32, 0.12, 0.09, 0.12, 0.12], ["left", "left", "left", "right", "right", "right", "right"],
                  size=7.0, bold_rows=(len(rows) - 1,))
        doc.text(f"{L['to']} {fdate(s['paid'], L['dfmt'])}: EUR {f(s['net'])}", 8)
    doc.space(4)
    doc.para(L["note"], 7, color=GREY)
    doc.save()


def amazon_invoice(path, M, month):
    inv = M.docs["amazon"]["invoices"][month]
    y, mo = month.split("-")
    doc = Doc(path, f"Amazon Services Europe invoice {month}")
    doc.text("Amazon Services Europe S.à r.l.", 13, bold=True)
    doc.text("38 avenue John F. Kennedy, L-1855 Luxembourg · VAT LU20260743", 8, color=GREY)
    doc.space(6)
    doc.at(doc.x1, doc.y + 20, "INVOICE", 16, bold=True, align="right")
    doc.kv([("Invoice number", f"FI-AEU-{y}{mo}-004471"), ("Invoice date", fdate(f"{month}-{'31'}", "en")),
            ("Billing period", f"1–31 {'Dec' if mo == '12' else 'Jan'} {y}"),
            ("Customer", f"{CO['name']}, {CO['address'][0]}, {CO['address'][1]}, Finland"), ("Customer VAT", CO["vat"])])
    doc.space(6)
    rows = [["Referral fees (Amazon.de)", en(inv["referral"])], ["Professional selling subscription", en(inv["subscription"])],
            ["Sponsored Products advertising", en(inv["ads"])], ["Total (VAT 0 %)", en(inv["total"])]]
    doc.table(["DESCRIPTION", "AMOUNT EUR"], rows, [0.7, 0.3], ["left", "right"], bold_rows=(3,))
    doc.para("VAT reverse charge: services taxable in the Member State of the recipient (Article 196, Directive "
             "2006/112/EC). The fees have been deducted from your settlement(s); no payment is due.", 7.8)
    doc.space(4)
    doc.text("Fee detail by date", 8.5, bold=True)
    frows = [[fdate(x[0], "en"), {"referral": "Referral fee", "subscription": "Subscription", "ads": "Advertising"}[x[1]], x[3], en(x[2])]
             for x in inv["fees"]]
    doc.table(["DATE", "TYPE", "ORDER", "EUR"], frows, [0.2, 0.3, 0.3, 0.2], ["left", "left", "left", "right"], size=7.2)
    doc.save()


# --------------------------------------------------------------------------
# B2B invoice + email
# --------------------------------------------------------------------------

def b2b_invoice(path, M):
    b = M.docs["b2b"]
    bi = D.B2B_INVOICE
    cu = D.CUSTOMER_B2B
    rows = []
    for r in b["rows"] + b["freight"]:
        rows.append([r["label"], r["qty"], fi(r["unit"]), f"{rk(r['rate'])} %", fi(r["net"]), fi(r["vat"]), fi(r["net"] + r["vat"])])
    rows.append([f"Lahjakortti {fi(m(bi['giftcard_value']))} € (monikäyttöinen, ei ALV:tä)", bi["giftcards"],
                 fi(m(bi["giftcard_value"])), "–", fi(b["giftcards"]), "0,00", fi(b["giftcards"])])
    totals = []
    for rate, (n, v) in vat_summary(b["rows"] + b["freight"]):
        totals.append((f"ALV {rk(rate)} % ({fi(n)})", fi(v), False))
    totals += [("Veroton yhteensä", fi(b["net"] + b["giftcards"]), False), ("ALV yhteensä", fi(b["vat"]), False),
               ("MAKSETTAVA", fi(b["gross"]) + " €", True)]
    fi_invoice(path, "Myyntilasku 2024-118",
               {"name": CO["name"], "lines": [f"{CO['address'][0]}, {CO['address'][1]} · Y-tunnus {CO['ytunnus']} · ALV-rek.",
                                               CO["email"]]},
               [cu["name"], cu["address"][0], cu["address"][1], f"Y-tunnus {cu['ytunnus']}", f"Viitteenne: {cu['contact']}"],
               [("Laskun numero", bi["no"]), ("Laskun päivä", fdate(bi["date"])), ("Toimituspäivä", fdate(bi["delivery"])),
                ("Maksuehto", "14 pv netto"), ("Eräpäivä", fdate(bi["due"])), ("Viitenumero", bi["ref"]),
                ("Viivästyskorko", "korkolain mukainen")],
               ["TUOTE", "MÄÄRÄ", "À-HINTA", "ALV", "VEROTON", "ALV €", "YHTEENSÄ"], rows,
               [0.39, 0.07, 0.1, 0.07, 0.12, 0.11, 0.14], ["left", "right", "right", "right", "right", "right", "right"], totals,
               notes=["Lahjalaatikon hinta 45,00 € (alv 0) on jaettu verokannoittain osien hankintahintojen suhteessa: "
                      "suklaa 14 %, kirja 10 %, muki 25,5 %. Rahti on jaettu samassa suhteessa.",
                      "Lahjakortit ovat monikäyttöisiä arvoseteleitä: arvonlisävero suoritetaan vasta, kun kortti käytetään."],
               pay_lines=[f"Saaja: {CO['name']} · IBAN {CO['iban_display']} · BIC {CO['bic']}",
                          f"Viitenumero {bi['ref']} · Eräpäivä {fdate(bi['due'])} · Summa {fi(b['gross'])} €"],
               band_color=colors.Color(0.55, 0.12, 0.2))


def b2b_email(path, M):
    b = M.docs["b2b"]
    bi = D.B2B_INVOICE
    doc = Doc(path, "Sähköposti Pohjoisen Insinööritoimisto")
    doc.text("Sähköpostiketju", 8, color=GREY)
    doc.kv([("Lähettäjä", "Marja Heikkilä <marja.heikkila@pohjoisen-insinoori.example>"),
            ("Vastaanottaja", "liisa@karkkiaitta.example"), ("Päivämäärä", "3.1.2025 klo 09.15"),
            ("Aihe", "Lasku 118 / joululahjat – maksu")])
    doc.hr()
    doc.para("Hei Liisa,\n\npahoittelut, laskunne jäi joulukiireissä hyväksymättä ja maksoimme sen vasta eilen. Huomasin nyt, "
             "että maksussa oli viitteen paikalla vain laskun numero. Lisäksi maksoin vahingossa 40 euroa liikaa: "
             "ajattelin, että lahjakortteja olisi tullut 21 kpl (tilasimme lopulta 20). Voisitteko palauttaa "
             f"liikasuorituksen tilillemme {D.CUSTOMER_B2B['iban']}?\n\nKiitos vielä – laatikot olivat hitti!\n\nMarja Heikkilä\n"
             "HR-assistentti, Pohjoisen Insinööritoimisto Oy", 9)
    doc.space(6)
    doc.hr()
    doc.kv([("Lähettäjä", "Liisa Kärkkäinen <liisa@karkkiaitta.example>"), ("Päivämäärä", "13.1.2025 klo 14.02"),
            ("Aihe", "RE: Lasku 118 / joululahjat – maksu")])
    doc.para(f"Hei Marja, kiitos! Maksu {fi(b['paid_amount'])} € on kirjattu laskulle {bi['no']}. Liikasuoritus 40,00 € "
             "on palautettu tänään tilillenne. Terveisin Liisa", 9)
    doc.save()


def giftcard_report(path, M):
    doc = Doc(path, "Lahjakorttiraportti")
    doc.band("Lahjakorttiraportti 1.12.2024–31.1.2025 (verkkokaupan hallinta)", 10, fill=colors.Color(0.37, 0.55, 0.24))
    rows = [["Avaava saldo 1.12.2024", "", "0,00"]]
    bal = ZERO
    for dd, a in D.GIFTCARDS_SOLD_WEB:
        bal += m(a)
        rows.append([f"{fdate(dd)} myyty verkkokaupassa (Paytrail)", fi(m(a)), fi(bal)])
    b = M.docs["b2b"]
    bal += b["giftcards"]
    rows.append([f"{fdate(D.B2B_INVOICE['date'])} yritystilaus, lasku {D.B2B_INVOICE['no']} (20 x 25 €)", fi(b["giftcards"]), fi(bal)])
    for mo, a in D.GIFTCARD_REDEEMED.items():
        bal -= m(a)
        rows.append([f"{'joulukuu 2024' if mo == '2024-12' else 'tammikuu 2025'}: käytetty verkkokaupan tilauksissa", fi(-m(a)), fi(bal)])
    rows.append(["Voimassa olevat kortit 31.1.2025", "", fi(bal)])
    doc.table(["TAPAHTUMA", "MÄÄRÄ EUR", "SALDO EUR"], rows, [0.6, 0.2, 0.2], ["left", "right", "right"], bold_rows=(len(rows) - 1,))
    doc.para("Kortit ovat voimassa 24 kuukautta ja käyvät kaikkiin verkkokaupan tuotteisiin (monikäyttöinen arvoseteli). "
             "Käytetyt kortit sisältyvät kuukauden myyntiraportin maksutapaan 'Gift card redemptions'.", 7.5, color=GREY)
    doc.save()


def return_form(path, M):
    r = next(x for x in M.docs["refunds"] if x["ret"]["kind"] == "return")
    ret = r["ret"]
    doc = Doc(path, "Palautuslomake W-24-1402")
    doc.band("PALAUTUSLOMAKE / ELECTRONIC RETURN FORM", 10, fill=colors.Color(0.37, 0.55, 0.24))
    doc.kv([("Tilaus", ret["id"]), ("Tilattu ja toimitettu", f"{fdate(ret['order_date'])} (lähetetty samana päivänä)"),
            ("Palautus saapunut varastoon", "7.1.2025"), ("Asiakas", "Satu R., Kempele (kuluttaja)"),
            ("Syy", "Peruutusoikeus 14 pv – lahja ei miellyttänyt"),
            ("Palautettavat tuotteet", "1 x Joulun Makea Lahjalaatikko (avaamaton)"),
            ("Hyvitys", f"{fi(r['priced']['gross'])} € sis. alkuperäinen toimitusmaksu 6,90 €"),
            ("Hyvitystapa", f"Paytrail, alkuperäinen maksutapa, {fdate(ret['refund_date'])}")])
    doc.space(4)
    doc.para("Kuluttajansuojalain mukaan myyjän on palautettava myös alkuperäiset vakiotoimituskulut. Palautettu laatikko "
             "palautettiin myyntivarastoon.", 8, color=GREY)
    doc.save()


def swedish_complaint(path, M):
    r = next(x for x in M.docs["refunds"] if x["ret"]["kind"] == "lost")
    ret = r["ret"]
    doc = Doc(path, "Reklamation W-24-1401")
    doc.text("E-post", 8, color=GREY)
    doc.kv([("Från", "Karin Lindqvist <karin.l@example-se.example>"), ("Till", CO["email"]), ("Datum", "2025-01-07 20:31"),
            ("Ämne", f"Reklamation – beställning {ret['id']} har inte kommit fram")])
    doc.hr()
    doc.para("Hej!\n\nJag beställde den 17 december en bok (Suomalaisen makeisen tarina), en chokladask och en mugg som "
             f"julklapp till min mamma i Uppsala. Paketet har aldrig kommit fram. Spårningen ({D.POSTI_CREDIT['tracking']}) har "
             "stått på \"Under transport\" sedan den 19 december. Kan ni återbetala hela beloppet inklusive frakt? Jag betalade "
             "med kort via Paytrail.\n\nVänliga hälsningar\nKarin Lindqvist", 9)
    doc.space(6)
    doc.hr()
    doc.kv([("Från", "Liisa Kärkkäinen <tilaukset@karkkiaitta.example>"), ("Datum", "2025-01-09 10:05"),
            ("Ämne", f"SV: Reklamation – beställning {ret['id']}")])
    doc.para(f"Hej Karin! Vi beklagar verkligen. Vi har idag återbetalat hela beloppet {fi(r['priced']['gross'])} EUR "
             "(varor och frakt) till ditt kort via Paytrail, och vi har anmält paketet som förlorat till Posti. "
             "Med vänlig hälsning, Liisa / Karkkiaitta", 9)
    doc.save()


# --------------------------------------------------------------------------
# Purchase invoices
# --------------------------------------------------------------------------

def purchase_invoice(path, M, key):
    p = M.docs["purchases"][key]
    s = p["spec"]
    sup = D.SUPPLIERS[s["sup"]]
    rows = [[r["desc"], r["qty"], fi(r["unit"]), (f"{rk(r['rate'])} %" if r["kind"] != "deposit" else "–"),
             fi(r["net"]), fi(r["vat"]), fi(r["net"] + r["vat"])] for r in p["rows"]]
    totals = []
    for rate, (n, v) in vat_summary(p["rows"]):
        if n and rate != "0":
            totals.append((f"ALV {rk(rate)} % ({fi(n)})", fi(v), False))
    totals += [("Veroton yhteensä", fi(p["net"]), False), ("ALV yhteensä", fi(p["vat"]), False),
               ("YHTEENSÄ", fi(p["gross"]) + " €", True)]
    notes = []
    if any(r["kind"] == "deposit" for r in p["rows"]):
        notes.append("Tölkkipantit eivät kuulu arvonlisäveron piiriin (palautettava pantti).")
    if key.startswith("ku"):
        notes.append("Kirjojen arvonlisävero 10 %.")
    if key == "lk-1224" or key == "lk-0131":
        notes.append("Lähetysmäärät pakettiautomaattiverkon seurannan mukaan.")
    colr = {"makeistukku": colors.Color(0.45, 0.2, 0.1), "kuusamo": colors.Color(0.1, 0.35, 0.2),
            "pakkaus": colors.Color(0.5, 0.45, 0.1), "lokerikko": colors.Color(0.9, 0.45, 0.1)}.get(s["sup"], colors.Color(0.2, 0.2, 0.2))
    fi_invoice(path, f"Ostolasku {s['no']}",
               {"name": sup["name"], "lines": [f"{sup['address'][0]}, {sup['address'][1]} · Y-tunnus {sup['ytunnus']}"]},
               [CO["name"], CO["address"][0], CO["address"][1]],
               [("Laskun numero", s["no"]), ("Laskun päivä", fdate(s["date"])), ("Toimituspäivä", fdate(s["delivery"])),
                ("Eräpäivä", fdate(s["due"])), ("Viitenumero", s["ref"]), ("Asiakasnumero", "40912")],
               ["TUOTE", "MÄÄRÄ", "À-HINTA", "ALV", "VEROTON", "ALV €", "YHTEENSÄ"], rows,
               [0.37, 0.08, 0.1, 0.08, 0.13, 0.11, 0.13], ["left", "right", "right", "right", "right", "right", "right"],
               totals, notes=notes,
               pay_lines=[f"Saaja {sup['name']} · IBAN {sup['iban']} · Viite {s['ref']} · Eräpäivä {fdate(s['due'])}"],
               band_color=colr)


def tuomas_email(path, M):
    t = M.docs["tuomas_net"]
    doc = Doc(path, "Sähköposti Tuomas Rautio")
    doc.text("Sähköpostiketju (välitetty kirjanpitäjälle)", 8, color=GREY)
    doc.kv([("Lähettäjä", "Tuomas Rautio <tuomas@karkkiaitta.example>"), ("Vastaanottaja", "liisa@karkkiaitta.example"),
            ("Päivämäärä", "7.12.2024 klo 21.40"), ("Aihe", "pakkauslasku maksettu")])
    doc.hr()
    doc.para(f"Moi, maksoin Oulun Pakkaustarvikkeen laskun 3391 ({fi(t['owed'])} €) omalta tililtäni, kun yrityksen "
             "verkkopankki ei toiminut lauantaina ja eräpäivä lähestyi. Firma on mulle tämän velkaa, ei kiirettä. -T", 9)
    doc.space(6)
    doc.hr()
    doc.kv([("Lähettäjä", "Tuomas Rautio"), ("Päivämäärä", "30.1.2025 klo 08.12"), ("Aihe", "RE: pakkauslasku maksettu")])
    doc.para(f"Hups – ostin 12.1. Amazonista omat juoksukengät vahingossa firman kortilla ({fi(t['private'])} €). "
             f"Vähennetään se siitä pakkauslaskun velasta, eli firma maksaa mulle netto {fi(t['net'])} €. Laitan tilauksen "
             "vahvistuksen liitteeksi. Voitko maksaa perjantaina?", 9)
    doc.save()


def amazon_private_order(path, M):
    t = next(x for x in D.CARD["txns"] if x[5] == "private")
    doc = Doc(path, "Amazon.de order confirmation")
    doc.text("amazon.de", 16, bold=True)
    doc.text("Order Confirmation · Bestellbestätigung", 9, color=GREY)
    doc.kv([("Order #", "304-5518812-7730144"), ("Placed on", "12 January 2025"), ("Ship to", "Tuomas Rautio, Oulu, Finland"),
            ("Payment", f"Mastercard ending in {D.CARD['last4']}")])
    doc.space(4)
    doc.table(["ITEM", "QTY", "PRICE EUR"],
              [["Men's trail running shoes, size 44", 1, en(m(t[3]) - m("5.99"))], ["Shipping to Finland", "", "5.99"],
               ["Order total (incl. VAT)", "", en(m(t[3]))]], [0.66, 0.1, 0.24], ["left", "right", "right"], bold_rows=(2,))
    doc.para("Sold by Amazon EU S.à r.l. Private purchase – no business use.", 7.5, color=GREY)
    doc.save()


def posti_invoice(path, M):
    px = M.docs["posti_dec"]
    pdc = D.POSTI_DEC
    rows = [[r["desc"], r["qty"], fi(r["unit"]), "25,5 %", fi(r["net"])] for r in px["rows"]]
    fi_invoice(path, "Posti lasku 12-2024",
               {"name": "Posti Oy", "lines": ["Asiakaspalvelu yritykset · posti.fi"]},
               [CO["name"], CO["address"][0], CO["address"][1], "Sopimusnumero 772104"],
               [("Laskun numero", pdc["no"]), ("Laskun päivä", fdate(pdc["date"])), ("Laskutusjakso", pdc["period"]),
                ("Eräpäivä", fdate(pdc["due"])), ("Viitenumero", pdc["ref"])],
               ["PALVELU", "KPL", "À-HINTA", "ALV", "VEROTON"], rows, [0.48, 0.1, 0.14, 0.12, 0.16],
               ["left", "right", "right", "right", "right"],
               [("Veroton yhteensä", fi(px["net"]), False), ("ALV 25,5 %", fi(px["vat"]), False),
                ("YHTEENSÄ", fi(px["gross"]) + " €", True)],
               notes=["Polttoainelisä lasketaan kuljetusmaksuista. Lisämaksuihin ei lasketa polttoainelisää."],
               band_color=colors.Color(0.98, 0.72, 0.0))


def posti_credit(path, M):
    pc = M.docs["posti_credit"]
    s = D.POSTI_CREDIT
    fi_invoice(path, "Posti hyvityslasku",
               {"name": "Posti Oy", "lines": ["Reklamaatiot / korvauskäsittely"]},
               [CO["name"], CO["address"][0], CO["address"][1]],
               [("Hyvityslasku", s["no"]), ("Päivä", fdate(s["date"])), ("Viittaa laskuun", s["ref_invoice"]),
                ("Lähetystunnus", s["tracking"]), ("Kohde", "Uppsala, SE (kadonnut)")],
               ["ERÄ", "", "", "ALV", "MÄÄRÄ"],
               [["Kuljetusmaksun hyvitys, Postipaketti EU", "", "", "25,5 %", fi(-pc["freight"])],
                ["Polttoainelisän hyvitys", "", "", "25,5 %", fi(-pc["fuel"])],
                ["ALV 25,5 %", "", "", "", fi(-pc["vat"])],
                ["Korvaus kadonneesta sisällöstä (vahingonkorvaus)", "", "", "ei ALV", fi(-pc["comp"])]],
               [0.5, 0.05, 0.05, 0.15, 0.25], ["left", "left", "left", "right", "right"],
               [("HYVITYS YHTEENSÄ", fi(-pc["total"]) + " €", True)],
               notes=["Hyvitys vähennetään seuraavasta laskusta. Sisällön korvaus perustuu yritysasiakkaan kuljetusehtoihin "
                      "(tavaran hankinta-arvo, enintään 150 €)."],
               heading="HYVITYSLASKU", band_color=colors.Color(0.98, 0.72, 0.0))


# --------------------------------------------------------------------------
# Imports
# --------------------------------------------------------------------------

def uk_invoice(path, M):
    uk = D.UK_IMPORT["invoice"]
    ukd = M.docs["uk"]
    doc = Doc(path, "Invoice TT-5521")
    doc.text("Thistle & Toffee Ltd", 16, bold=True)
    doc.text(", ".join(D.SUPPLIERS["thistle"]["address"]) + f" · VAT {D.SUPPLIERS['thistle']['vat']} · EORI {D.SUPPLIERS['thistle']['eori']}", 7.5, color=GREY)
    doc.space(8)
    doc.at(doc.x1, doc.y + 24, "COMMERCIAL INVOICE", 14, bold=True, align="right")
    doc.kv([("Invoice no.", uk["no"]), ("Date", fdate(uk["date"], "en")), ("Incoterms", uk["incoterm"]),
            ("Buyer", f"{CO['name']}, {CO['address'][0]}, {CO['address'][1]}, Finland · VAT {CO['vat']}"),
            ("Payment", f"Bank transfer in GBP, due {fdate(uk['due'], 'en')}")])
    doc.space(6)
    rows = [[d_, q, en(m(u)), en(m(pct(u) * q))] for d_, q, u in uk["lines"]]
    rows.append(["TOTAL GBP (zero-rated export)", "", "", en(ukd["gbp"])])
    doc.table(["DESCRIPTION", "QTY", "UNIT GBP", "AMOUNT GBP"], rows, [0.55, 0.1, 0.15, 0.2], ["left", "right", "right", "right"],
              bold_rows=(len(rows) - 1,))
    doc.para("Statement on origin: " + uk["origin_statement"], 7.8)
    doc.para("Goods collected ex works by the buyer's forwarder (Pohjanlahden Huolinta Oy).", 7.8)
    doc.save()


def customs_decision(path, M, which):
    if which == "uk":
        spec, dd = D.UK_IMPORT, M.docs["uk"]
        goods_line = ("1704 90 75 00", "Toffee / kermatoffee, vähittäismyyntipakkaus", "GB", "Etuuskohtelu (EU–UK kauppa- ja "
                      "yhteistyösopimus), alkuperäilmoitus laskulla", f"{fi(dd['gbp'])} GBP")
        rate = "14"
        goods_eur = dd["goods_eur_customs"]
    else:
        spec, dd = D.CHINA_IMPORT, M.docs["cn"]
        goods_line = ("6912 00 50 00", "Kivitavaramukit (stoneware), 600 kpl", "CN", "Kolmannen maan tulli", f"{en(dd['usd'])} USD")
        rate = "25.5"
        goods_eur = dd["goods_customs"]
    cu = spec["customs"]
    doc = Doc(path, f"Tullauspäätös {cu['date']}")
    doc.band("TULLI · TULLAUSPÄÄTÖS / TULLBESLUT", 11, fill=colors.Color(0.0, 0.2, 0.45))
    doc.kv([("MRN", cu["mrn"]), ("Päätöspäivä", fdate(cu["date"])), ("Tuoja", f"{CO['name']} ({CO['ytunnus']}), EORI FI{CO['ytunnus'].replace('-', '')}"),
            ("Ilmoittaja (edustaja)", "Pohjanlahden Huolinta Oy, välillinen edustus"),
            ("Tullimenettely", "Luovutus vapaaseen liikkeeseen (40 00)")])
    doc.space(4)
    doc.table(["TAVARANIMIKE", "KUVAUS", "ALKUPERÄ", "TULLIKOHTELU", "LASKUN ARVO"], [list(goods_line)],
              [0.14, 0.3, 0.09, 0.3, 0.17], ["left", "left", "left", "left", "right"], size=7.6)
    rows = [["Tavaran arvo euroina (Tullin kurssi " + cu["customs_rate"] + ")", fi(goods_eur)],
            ["Kuljetus EU:n rajalle", fi(m(cu["freight_to_border"]))],
            ["TULLIARVO", fi(dd["customs_value"])],
            [f"Tulli {cu['duty_pct'].replace('.', ',')} %", fi(dd["duty"])],
            ["Kuljetus EU:n rajalta määräpaikkaan (Oulu)", fi(m(cu["freight_inland"]))],
            ["ARVONLISÄVERON PERUSTE", fi(dd["base"])],
            [f"Arvonlisävero {rk(rate)} %", fi(dd["ivat"])]]
    doc.table(["VEROPERUSTE", "EUR"], rows, [0.7, 0.3], ["left", "right"], bold_rows=(2, 5))
    doc.space(2)
    doc.para(f"Maksuunpantavat: tulli {fi(dd['duty'])} € (maksetaan Tullille; edustaja on maksanut). "
             "Arvonlisävero: tuoja on arvonlisäverovelvollinen, maahantuonnin arvonlisävero ilmoitetaan Verohallinnolle "
             "kausiveroilmoituksella eikä sitä peritä tällä päätöksellä.", 8)
    doc.save()


def forwarder_invoice(path, M, which):
    spec, dd = (D.UK_IMPORT, M.docs["uk"]) if which == "uk" else (D.CHINA_IMPORT, M.docs["cn"])
    f = spec["forwarder"]
    rows = [["Kuljetus " + ("Sheffield – Oulu (maantie/lautta)" if which == "uk" else "Ningbo – Kotka – Oulu (meri + maantie)"),
             "0 %", fi(m(f["freight"])), "0,00"]]
    if which == "cn":
        rows.append(["Tulli (läpilaskutus, Tullin päätös " + spec["customs"]["mrn"] + ")", "–", fi(dd["duty"]), "0,00"])
    rows.append(["Tulliselvitys ja edustus", "25,5 %", fi(m(f["clearance_fee"])), fi(dd["fwd_vat"])])
    net = m(f["freight"]) + m(f["clearance_fee"]) + (dd["duty"] if which == "cn" else ZERO)
    fi_invoice(path, f"Huolintalasku {f['no']}",
               {"name": D.SUPPLIERS["huolinta"]["name"], "lines": [f"{D.SUPPLIERS['huolinta']['address'][0]}, "
                                                                    f"{D.SUPPLIERS['huolinta']['address'][1]} · Y-tunnus {D.SUPPLIERS['huolinta']['ytunnus']}"]},
               [CO["name"], CO["address"][0], CO["address"][1]],
               [("Laskun numero", f["no"]), ("Laskun päivä", fdate(f["date"])), ("Eräpäivä", fdate(f["due"])),
                ("Viitenumero", f["ref"]), ("Lähetys", spec["customs"]["mrn"])],
               ["ERÄ", "ALV", "VEROTON", "ALV €"], rows, [0.55, 0.1, 0.18, 0.17], ["left", "right", "right", "right"],
               [("Veroton yhteensä", fi(net), False), ("ALV 25,5 %", fi(dd["fwd_vat"]), False),
                ("YHTEENSÄ", fi(dd["fwd_total"]) + " €", True)],
               notes=["Tuontikuljetus on veroton (AVL 71 §), koska sen arvo sisältyy maahantuonnin arvonlisäveron perusteeseen. "
                      + ("Tulli on maksettu puolestanne ja laskutetaan sellaisenaan." if which == "cn" else "")],
               band_color=colors.Color(0.0, 0.3, 0.3))


def china_invoice(path, M):
    cn = D.CHINA_IMPORT
    dd = M.docs["cn"]
    doc = Doc(path, "Commercial invoice HF-24-1107")
    doc.text(D.SUPPLIERS["hengfeng"]["name"], 14, bold=True)
    doc.text(", ".join(D.SUPPLIERS["hengfeng"]["address"]), 7.5, color=GREY)
    doc.space(8)
    doc.at(doc.x1, doc.y + 24, "COMMERCIAL INVOICE", 14, bold=True, align="right")
    doc.kv([("Invoice no.", cn["invoice"]["no"]), ("Date", fdate(cn["invoice"]["date"], "en")),
            ("Terms of delivery", cn["invoice"]["incoterm"] + ", shipped on board " + fdate(cn["invoice"]["shipped"], "en")),
            ("B/L", cn["invoice"]["bl"]), ("Buyer", f"{CO['name']}, Oulu, Finland"),
            ("Payment terms", "30 % T/T in advance, 70 % T/T against copy of B/L")])
    doc.space(6)
    rows = [[d_, q, en(m(u)), en(m(pct(u) * q))] for d_, q, u in cn["invoice"]["lines"]]
    rows += [["Total USD", "", "", en(dd["usd"])], ["Less advance received 18 Nov 2024", "", "", en(-m(cn["advance_usd"]))],
             ["BALANCE DUE USD", "", "", en(m(cn["balance_usd"]))]]
    doc.table(["DESCRIPTION", "QTY", "UNIT USD", "AMOUNT USD"], rows, [0.55, 0.1, 0.15, 0.2], ["left", "right", "right", "right"],
              bold_rows=(len(rows) - 1,))
    doc.para("Country of origin: China. HS 6912.00. Vessel ETA Kotka 3 Jan 2025.", 7.8)
    doc.save()


# --------------------------------------------------------------------------
# SaaS / ads receipts
# --------------------------------------------------------------------------

def saas_pack(path, M, kind):
    txns = [t for t in D.CARD["txns"] if t[5] == kind]
    meta = {
        "shopify": ("Shopify International Limited", "Victoria Buildings, 1-2 Haddington Road, Dublin 4, Ireland",
                    "Bills are charged in USD to the card on file. Irish VAT is not charged: reverse charge applies to "
                    "business customers established in another EU Member State."),
        "mailchimp": ("The Rocket Science Group LLC d/b/a Mailchimp", "405 N Angier Ave NE, Atlanta, GA 30308, USA",
                      "No VAT charged. Customer is responsible for accounting for any VAT due in its country."),
        "meta": ("Meta Platforms Ireland Limited", "4 Grand Canal Square, Grand Canal Harbour, Dublin 2, Ireland · VAT IE9692928F",
                 "Reverse charge: VAT to be accounted for by the recipient (Article 196, Directive 2006/112/EC)."),
        "google": ("Google Ireland Limited", "Gordon House, Barrow Street, Dublin 4, Ireland · VAT IE6388047V",
                   "Reverse charge – VAT to be self-assessed by the recipient."),
        "kirjuri": ("Kirjuri Pilvi Oy", "Kauppakatu 19, 40100 Jyväskylä · Y-tunnus " + D.SUPPLIERS["kirjuri"]["ytunnus"],
                    "Hinnat sisältävät arvonlisäveron 25,5 %. Veloitettu kortilta."),
    }[kind]
    doc = Doc(path, f"{kind} receipts")
    doc.text(meta[0], 13, bold=True)
    doc.text(meta[1], 7.5, color=GREY)
    doc.space(4)
    for t in txns:
        date, merch, desc, eur, orig, _ = t
        doc.hr()
        if kind == "kirjuri":
            vat = vat_from_gross(m(eur), "25.5")
            doc.text(f"LASKU / KUITTI · {fdate(date)} · {desc}", 9, bold=True)
            doc.table(["TUOTE", "VEROTON", "ALV 25,5 %", "YHTEENSÄ"],
                      [["Kirjuri Pilvi Pro, 1 yritys", fi(m(eur) - vat), fi(vat), fi(m(eur))]],
                      [0.46, 0.18, 0.18, 0.18], ["left", "right", "right", "right"])
            doc.text(f"Asiakas: {CO['name']} ({CO['ytunnus']}) · maksettu kortilla **** {D.CARD['last4']}", 7.5)
            continue
        cur = orig[0] if orig else "EUR"
        amt = orig[1] if orig else eur
        doc.text(f"{'Receipt' if kind in ('meta', 'google') else 'Invoice'} · {fdate(date, 'en')} · {desc}", 9, bold=True)
        rows = [[desc, f"{cur} {en(m(amt))}"], ["VAT 0 % (reverse charge)" if kind != "mailchimp" else "Tax", f"{cur} 0.00"],
                ["Total charged to Mastercard **** " + D.CARD["last4"], f"{cur} {en(m(amt))}"]]
        doc.table(["DESCRIPTION", "AMOUNT"], rows, [0.7, 0.3], ["left", "right"], bold_rows=(2,))
        doc.text(f"Bill to: {CO['name']}, Oulu, Finland · VAT ID {CO['vat']}", 7.5)
    doc.space(4)
    doc.para(meta[2], 7.5, color=GREY)
    doc.save()


# --------------------------------------------------------------------------
# Photo receipts (JPEG, Pillow)
# --------------------------------------------------------------------------

def photo_receipt(path, header_lines, item_lines, total, vat_lines, footer_lines, seed, angle):
    """Draw the receipt with ReportLab (Courier, full Latin-1), rasterise it with
    PyMuPDF, then photograph it with Pillow: paper texture, fold, rotation, table
    background, JPEG. Everything is seeded, so the JPEG is byte-identical."""
    import io

    import pymupdf
    from PIL import Image, ImageFilter
    from reportlab.pdfgen import canvas as rl_canvas

    rnd = random.Random(seed)
    lines = [(h, 11 if i == 0 else 8.5, True if i == 0 else False, "c") for i, h in enumerate(header_lines)]
    lines.append(("-" * 36, 8.5, False, "c"))
    for name, qty, price in item_lines:
        lines.append((name, 8.5, False, "l"))
        lines.append((f"   {qty} x {fi(m(price))}".ljust(26) + fi(m(pct(price) * int(qty))).rjust(10), 8.5, False, "l"))
    lines.append(("-" * 36, 8.5, False, "c"))
    lines.append(("YHTEENSÄ EUR".ljust(26) + fi(total).rjust(10), 9.5, True, "l"))
    lines.append((f"KORTTI **** {D.CARD['last4']} MASTERCARD", 8.5, False, "l"))
    lines.append(("", 8.5, False, "l"))
    for v in vat_lines:
        lines.append((v, 8.5, False, "l"))
    lines.append(("", 8.5, False, "l"))
    for f in footer_lines:
        lines.append((f, 8.5, False, "c"))
    lines.append((SYN, 5.5, False, "c"))
    w_pt, lead = 80 * mm, 12
    h_pt = 30 + lead * len(lines)
    buf = io.BytesIO()
    c = rl_canvas.Canvas(buf, pagesize=(w_pt, h_pt), invariant=1)
    y = h_pt - 18
    for s, size, bold, al in lines:
        c.setFont("Courier-Bold" if bold else "Courier", size)
        if al == "c":
            c.drawCentredString(w_pt / 2, y, s)
        else:
            c.drawString(8, y, s)
        y -= lead
    c.save()
    page = pymupdf.open(stream=buf.getvalue(), filetype="pdf")[0]
    pix = page.get_pixmap(dpi=190, colorspace=pymupdf.csGRAY)
    paper = Image.frombytes("L", (pix.width, pix.height), pix.samples)
    W, H = paper.size
    # warm paper, faint speckles, a vertical fold
    paper = paper.point(lambda v: int(40 + v * (246 - 40) / 255))
    px = paper.load()
    for _ in range(W * H // 180):
        x, yy = rnd.randrange(W), rnd.randrange(H)
        px[x, yy] = max(0, px[x, yy] - rnd.randint(10, 35))
    fold = W // 2 + rnd.randint(-20, 20)
    for yy in range(H):
        for x in range(fold - 3, fold + 3):
            px[x, yy] = max(0, px[x, yy] - 9)
    paper = paper.filter(ImageFilter.GaussianBlur(0.7))
    bgW, bgH = W + 240, H + 200
    bg = Image.new("L", (bgW, bgH), 92)
    bpx = bg.load()
    for _ in range(bgW * bgH // 30):
        x, yy = rnd.randrange(bgW), rnd.randrange(bgH)
        bpx[x, yy] = rnd.randint(70, 115)
    rot = paper.rotate(angle, resample=Image.BICUBIC, expand=True, fillcolor=0)
    mask = Image.new("L", paper.size, 255).rotate(angle, resample=Image.BICUBIC, expand=True, fillcolor=0)
    bg.paste(rot, ((bgW - rot.size[0]) // 2, (bgH - rot.size[1]) // 2), mask)
    rgb = Image.merge("RGB", (bg, bg.point(lambda v: max(0, v - 4)), bg.point(lambda v: max(0, v - 12))))
    rgb.save(path, format="JPEG", quality=80, optimize=False, progressive=False, subsampling=2)


def krauta_photo(path):
    total = sum((m(pct(p) * int(q)) for _, q, p in D.KRAUTA_RECEIPT), ZERO)
    vat = vat_from_gross(total, "25.5")
    photo_receipt(path, ["K-RAUTA", "LIMINGANPORTTI OULU", "Y-TUNNUS ####### - #*", "11.12.2024 KLO 16:47"],
                  D.KRAUTA_RECEIPT, total,
                  [f"ALV 25,5%  VEROTON {fi(total - vat)}", f"           VERO    {fi(vat)}"],
                  ["KIITOS KÄYNNISTÄ", "*haalistunut, ei luettavissa"], seed=4471, angle=-3.2)


def tokmanni_photo(path):
    total = sum((m(pct(p) * int(q)) for _, q, p in D.TOKMANNI_RECEIPT), ZERO)
    vat = vat_from_gross(total, "25.5")
    photo_receipt(path, ["TOKMANNI", "OULU KAAKKURI", "13.12.2024 KLO 10:05"], D.TOKMANNI_RECEIPT, total,
                  [f"ALV 25,5%  VEROTON {fi(total - vat)}", f"           VERO {fi(vat)}"],
                  ["TERVETULOA UUDELLEEN"], seed=8123, angle=2.4)


# --------------------------------------------------------------------------
# Payroll
# --------------------------------------------------------------------------

def payslip_doc(path, M, key):
    p = M.docs["payslips"][key]
    emp = D.EMPLOYEE
    r = p["rates"]
    doc = Doc(path, f"Palkkalaskelma {key}")
    doc.band(f"PALKKALASKELMA · maksupäivä {fdate(p['paid'])}" + (" · LOPPUTILI" if key == "P3" else ""), 11,
             fill=colors.Color(0.3, 0.3, 0.3))
    doc.kv([("Työnantaja", f"{CO['name']} · {CO['ytunnus']}"), ("Työntekijä", f"{emp['name']} (synt. {emp['born']})"),
            ("Tehtävä", emp["role"]), ("Palkkajakso", f"{fdate(p['period'][0])}–{fdate(p['period'][1])}"),
            ("Työsuhde", "määräaikainen 25.11.2024–31.01.2025"), ("Verokortti", f"{p['year']}: {p['taxpct'].replace('.', ',')} % (ei tulorajaa ylitetty)"),
            ("Maksetaan tilille", emp["iban"])])
    doc.space(4)
    rows = [[a, b, fi(c)] for a, b, c in p["rows"]]
    rows.append(["BRUTTOPALKKA", "", fi(p["gross"])])
    rows += [["Ennakonpidätys", f"{p['taxpct'].replace('.', ',')} %", fi(-p["tax"])],
             ["Työntekijän TyEL-maksu", f"{r['tyel_employee'].replace('.', ',')} %", fi(-p["tyel_e"])],
             ["Työntekijän työttömyysvakuutusmaksu", f"{r['tvr_employee'].replace('.', ',')} %", fi(-p["tvr_e"])],
             ["NETTOPALKKA", "", fi(p["net"])]]
    doc.table(["PALKKALAJI / PIDÄTYS", "PERUSTE", "EUR"], rows, [0.5, 0.25, 0.25], ["left", "left", "right"],
              bold_rows=(len(p["rows"]), len(rows) - 1))
    doc.space(4)
    doc.text("Työnantajan maksut (eivät vähennä nettopalkkaa)", 9, bold=True)
    doc.table(None, [["Työnantajan TyEL-maksu (Elo)", f"{r['tyel_employer'].replace('.', ',')} %", fi(p["tyel_r"])],
                     ["Työnantajan sairausvakuutusmaksu", f"{r['sava'].replace('.', ',')} %", fi(p["sava"])],
                     ["Työnantajan työttömyysvakuutusmaksu", f"{r['tvr_employer'].replace('.', ',')} %", fi(p["tvr_r"])]],
              [0.5, 0.25, 0.25], ["left", "left", "right"])
    doc.para(f"Ilmoitettu tulorekisteriin maksupäivän mukaan. Ennakonpidätys ja sava maksetaan Verohallinnolle maksupäivää "
             f"seuraavan kuukauden 12. päivänä. Sivukulut on laskettu maksupäivän ({p['year']}) prosenteilla.", 7.5, color=GREY)
    if key == "P3":
        doc.para(f"Lomakorvaus: työsopimuksen mukaan alle 14 työpäivää kuukaudessa ja työsuhde alle vuoden, joten "
                 f"lomapalkka/-korvaus lasketaan prosenttiperusteisesti: 9 % koko työsuhteen aikana ansaitusta palkasta "
                 f"({fi(p['holiday_basis'])} €), maksetaan lopputilin yhteydessä.", 7.5, color=GREY)
    doc.save()


def hours_report(path, M):
    doc = Doc(path, "Tuntiraportti 12-2024")
    doc.band("TYÖAIKARAPORTTI · Veera Nieminen · joulukuu 2024", 10, fill=colors.Color(0.3, 0.3, 0.3))
    # a plausible day plan that sums to the payslip P2 hours
    plan = [("02.12. ma", 8, 2, 0), ("04.12. ke", 8, 2, 0), ("05.12. to", 8, 2, 0), ("09.12. ma", 8, 0, 0),
            ("10.12. ti", 8, 2, 0), ("11.12. ke", 8, 3, 0), ("12.12. to", 8, 3, 0), ("15.12. su", 6, 0, 6),
            ("16.12. ma", 8, 3, 0), ("17.12. ti", 8, 3, 0), ("18.12. ke", 8, 2, 0), ("19.12. to", 8, 0, 0),
            ("22.12. su", 6, 0, 6)]
    tot = [sum(x[i] for x in plan) for i in (1, 2, 3)]
    p2 = M.docs["payslips"]["P2"]
    rows = [[a, b, c or "", dd or ""] for a, b, c, dd in plan]
    rows.append(["YHTEENSÄ", tot[0], tot[1], tot[2]])
    doc.table(["PÄIVÄ", "TUNNIT", "JOISTA ILTA (klo 18–)", "JOISTA SUNNUNTAI"], rows, [0.3, 0.2, 0.25, 0.25],
              ["left", "right", "right", "right"], bold_rows=(len(rows) - 1,))
    doc.para(f"Työpäiviä {len(plan)} (työsopimus: työvuorot sovitaan viikoittain, alle 14 päivää kuukaudessa, enintään 8 h/pv). "
             "Hyväksytty: Liisa Kärkkäinen 31.12.2024. Iltalisä työsopimuksen mukaan 20 % ma–pe klo 18 jälkeen; "
             "sunnuntaityöstä korotus 100 % (työaikalaki).", 7.5, color=GREY)
    want = [D.PAYSLIPS[1]["hours"], D.PAYSLIPS[1]["evening"], D.PAYSLIPS[1]["sunday"]]
    if tot != want:
        raise ValueError(f"hours report {tot} != payslip P2 {want}")
    doc.save()
    return tot


def tulorekisteri(path, M):
    P = M.docs["payslips"]
    doc = Doc(path, "Tulorekisteri palkkatietoilmoitukset")
    doc.band("TULOREKISTERI · Palkkatietoilmoitukset (yhteenveto)", 10, fill=colors.Color(0.0, 0.2, 0.45))
    doc.kv([("Ilmoittaja", f"{CO['name']} ({CO['ytunnus']})"), ("Tulonsaaja", f"{D.EMPLOYEE['name']}, synt. {D.EMPLOYEE['born']}"),
            ("Vakuutukset", "TyEL Elo (sopimus 61-2204118) · tapaturma: Revontuli")])
    rows = []
    for k in ("P1", "P2", "P3"):
        p = P[k]
        rows.append([fdate(p["paid"]), f"{fdate(p['period'][0])}–{fdate(p['period'][1])}", fi(p["gross"]), fi(p["tax"]),
                     fi(p["tyel_e"]), fi(p["tvr_e"]),
                     "Vastaanotettu " + {"P1": "12.12.2024", "P2": "13.01.2025", "P3": "odottaa (lähetetään maksupäivänä)"}[k]])
    doc.table(["MAKSUPÄIVÄ", "ANSAINTAJAKSO", "RAHAPALKKA", "ENNAKONPID.", "TYEL", "TVR", "TILA"], rows,
              [0.12, 0.2, 0.12, 0.12, 0.1, 0.1, 0.24], ["left", "left", "right", "right", "right", "right", "left"], size=7.4)
    doc.para("Työnantajan erillisilmoitus: sava ja maksuvelvollisuus ilmoitetaan kuukausittain maksukuukauden mukaan. "
             "Ilmoitus on annettava viimeistään viidentenä kalenteripäivänä maksupäivän jälkeen.", 7.5, color=GREY)
    doc.save()


def elo_tyel(path, M):
    t = M.docs["tyel_invoice"]
    fi_invoice(path, "TyEL-lasku 12-2024", {"name": "Elo Keskinäinen Työeläkevakuutusyhtiö", "lines": ["elo.fi"]},
               [CO["name"], CO["address"][0], CO["address"][1], "Sopimusnumero 61-2204118"],
               [("Lasku", "TYEL-2412-339104"), ("Laskun päivä", "07.01.2025"), ("Eräpäivä", "20.01.2025"),
                ("Viitenumero", "61008452"), ("Maksuperuste", "tulorekisteri, palkat maksettu 12/2024")],
               ["ERÄ", "PERUSTE", "%", "EUR"],
               [["Työntekijän TyEL-maksu (pidätetty palkasta)", fi(t["wages"]), rk(D.PAYROLL_RATES["2024"]["tyel_employee"]), fi(t["employee"])],
                ["Työnantajan TyEL-maksu", fi(t["wages"]), rk(D.PAYROLL_RATES["2024"]["tyel_employer"]), fi(t["employer"])]],
               [0.5, 0.18, 0.12, 0.2], ["left", "right", "right", "right"],
               [("MAKSETTAVA", fi(t["total"]) + " €", True)],
               notes=["TyEL-maksut eivät ole arvonlisäverollisia. Vuoden 2024 TyEL-maksu: keskimäärin 24,81 %, "
                      "työntekijän osuus 7,15 % (17–52- ja 63–67-vuotiaat)."],
               heading="LASKU", band_color=colors.Color(0.0, 0.45, 0.4))


def elo_yel(path, M, who):
    f = next(x for x in D.FOUNDERS if x["key"] == who)
    y = next(x for x in D.YEL_INVOICES if x["founder"] == who)
    amt = M.docs["yel"][who]
    notes = [f"YEL-työtulo {fi(pct(f['yel_income']))} €/v · maksuprosentti 2024 {D.YEL_RATE.replace('.', ',')} % · "
             "laskutus kuukausittain. YEL-maksu on yrittäjän henkilökohtainen, verotuksessa vähennyskelpoinen maksu."]
    if who == "tuomas":
        notes.append("Käsin merkitty: \"maksettu omalta tililtä 4.12. – T.R.\"")
    fi_invoice(path, f"YEL-lasku {f['name']}", {"name": "Elo Keskinäinen Työeläkevakuutusyhtiö", "lines": ["elo.fi"]},
               [f["name"], "Kärkkäinen: Pikisaarentie 3, 90100 Oulu" if who == "liisa" else "Rautio: Myllytie 11, 90500 Oulu"],
               [("Lasku", y["no"]), ("Laskun päivä", fdate(y["date"])), ("Eräpäivä", fdate(y["due"])),
                ("Viitenumero", y["ref"]), ("Vakuutus", f"YEL, vakuutettu {f['name']}")],
               ["ERÄ", "EUR"], [["YEL-vakuutusmaksu 12/2024", fi(amt)]], [0.8, 0.2], ["left", "right"],
               [("MAKSETTAVA", fi(amt) + " €", True)], notes=notes, band_color=colors.Color(0.0, 0.45, 0.4))


def tvr_invoice(path, M):
    t = M.docs["tvr_invoice"]
    fi_invoice(path, "Työllisyysrahasto lasku", {"name": "Työllisyysrahasto", "lines": ["tyollisyysrahasto.fi"]},
               [CO["name"], CO["address"][0], CO["address"][1]],
               [("Lasku", "TVR-2025-0118834"), ("Laskun päivä", "10.01.2025"), ("Eräpäivä", "28.01.2025"),
                ("Viitenumero", "44002187"), ("Jakso", "palkat maksettu 1.10.–31.12.2024")],
               ["ERÄ", "PALKKASUMMA", "%", "EUR"],
               [["Palkansaajan työttömyysvakuutusmaksu", fi(t["wages"]), rk(D.PAYROLL_RATES["2024"]["tvr_employee"]), fi(t["employee"])],
                ["Työnantajan työttömyysvakuutusmaksu", fi(t["wages"]), rk(D.PAYROLL_RATES["2024"]["tvr_employer"]), fi(t["employer"])]],
               [0.5, 0.18, 0.12, 0.2], ["left", "right", "right", "right"],
               [("MAKSETTAVA", fi(t["total"]) + " €", True)],
               notes=["Maksut perustuvat tulorekisteriin ilmoitettuihin palkkoihin (vuoden 2024 maksuprosentit)."],
               band_color=colors.Color(0.2, 0.3, 0.55))


def accident_invoice(path, M):
    a = M.docs["accident"]
    ai = D.ACCIDENT_INSURANCE
    fi_invoice(path, "Tapaturmavakuutus 2025", {"name": D.SUPPLIERS["revontuli"]["name"],
                                                "lines": [f"{D.SUPPLIERS['revontuli']['address'][0]}, Oulu · Y-tunnus {D.SUPPLIERS['revontuli']['ytunnus']}"]},
               [CO["name"], CO["address"][0], CO["address"][1]],
               [("Lasku", ai["no"]), ("Laskun päivä", fdate(ai["date"])), ("Eräpäivä", fdate(ai["due"])),
                ("Viitenumero", ai["ref"]), ("Vakuutuskausi", ai["period"])],
               ["ERÄ", "PERUSTE", "EUR"],
               [["Lakisääteinen työtapaturma- ja ammattitautivakuutus, ennakko", f"arv. palkkasumma {fi(pct(ai['estimated_payroll']))} × {D.ACCIDENT_INS_RATE.replace('.', ',')} % = {fi(a['calc'])}", ""],
                ["Vähimmäismaksu", "", fi(a["premium"])]],
               [0.5, 0.3, 0.2], ["left", "left", "right"], [("MAKSETTAVA", fi(a["premium"]) + " €", True)],
               notes=["Lakisääteinen tapaturmavakuutus on vakuutusmaksuverosta vapaa. Ennakkomaksu tarkistetaan "
                      "toteutuneen palkkasumman mukaan vuoden 2025 päätyttyä."],
               band_color=colors.Color(0.1, 0.2, 0.45))


# --------------------------------------------------------------------------
# OmaVero
# --------------------------------------------------------------------------

def omavero(path, M):
    cp = M.docs["combined_payment"]
    li = M.docs["late_interest"]
    doc = Doc(path, "OmaVero verotili")
    doc.band("OmaVero · Oma-aloitteiset verot · Tapahtumat 1.12.2024–31.1.2025", 10, fill=colors.Color(0.0, 0.2, 0.45))
    doc.kv([("Asiakas", f"{CO['name']} ({CO['ytunnus']})"), ("Viitenumero (oma-aloitteiset verot)", D.TAX["ref"]),
            ("Tulostettu", "03.02.2025")])
    doc.space(4)
    oct_ = m(D.OPENING["2941_oct"])
    rows = [["12.12.2024", "Arvonlisävero 10/2024, eräpäivä", "", fi(oct_)],
            ["20.12.2024", "Maksu viitteellä " + D.TAX["ref"], fi(oct_), ""],
            ["20.12.2024", "Kohdistettu: arvonlisävero 10/2024", "", ""],
            ["13.01.2025", "Arvonlisävero 11/2024, eräpäivä", "", fi(cp["alv_nov"])],
            ["13.01.2025", "Ennakonpidätys, palkat maksettu 12/2024", "", fi(cp["tax"])],
            ["13.01.2025", "Työnantajan sairausvakuutusmaksu 12/2024", "", fi(cp["sava"])],
            ["13.01.2025", f"Viivästyskorko, ALV 10/2024 ({li['days']} pv, {D.TAX_LATE_INTEREST_2024.replace('.', ',')} %)", "", fi(cp["interest"])],
            ["13.01.2025", "Maksu viitteellä " + D.TAX["ref"], fi(cp["total"]), ""],
            ["13.01.2025", "Kohdistettu: viivästyskorko, ALV 11/2024, ennakonpidätys 12/2024, sava 12/2024", "", ""]]
    doc.table(["PÄIVÄ", "TAPAHTUMA", "MAKSU", "VELKA"], rows, [0.13, 0.57, 0.15, 0.15], ["left", "left", "right", "right"], size=7.6)
    doc.para("Verotilin saldo 31.1.2025: 0,00 €. Kausiveroilmoitukset 12/2024 (eräpäivä 12.2.2025) ja 1/2025 (eräpäivä "
             "12.3.2025) sekä 1/2025 maksettujen palkkojen ennakonpidätys ja sava (eräpäivä 12.2.2025) eivät vielä näy.", 7.5, color=GREY)
    doc.space(6)
    doc.text("Viivästyskoron laskelma", 9, bold=True)
    doc.para(f"ALV 10/2024 {fi(oct_)} € × {D.TAX_LATE_INTEREST_2024.replace('.', ',')} % × {li['days']}/365 = {fi(li['amount'])} €", 8)
    doc.save()


def oss_return(path, M):
    fig = M.figures["2024-12"]["oss"]
    doc = Doc(path, "OSS-ilmoitus Q4 2024")
    doc.band("OmaVero · Unionin erityisjärjestelmä (OSS) · Veroilmoitus Q4/2024", 10, fill=colors.Color(0.0, 0.2, 0.45))
    doc.kv([("Asiakas", f"{CO['name']} · FI OSS-tunniste {CO['vat']}"), ("Rekisteröity", f"{fdate(D.TAX['oss_registered'])} "
            "(ensimmäinen OSS-myynti 10.12.2024)"), ("Kausi", "1.10.–31.12.2024"), ("Ilmoitettu", "27.01.2025"),
            ("Eräpäivä", "31.01.2025"), ("Maksuviite", D.TAX["oss_ref"])])
    doc.space(4)
    rows = []
    for (cc, rate), (base, tax) in sorted(fig.items()):
        rows.append([cc, f"{rk(rate)} %", "yhteisön sisäinen tavaroiden etämyynti", fi(base), fi(tax)])
    rows.append(["", "", "YHTEENSÄ", fi(sum((v[0] for v in fig.values()), ZERO)), fi(sum((v[1] for v in fig.values()), ZERO))])
    doc.table(["KULUTUSJÄSENVALTIO", "VEROKANTA", "MYYNTILAJI", "VEROTON EUR", "VERO EUR"], rows,
              [0.17, 0.12, 0.37, 0.17, 0.17], ["left", "left", "left", "right", "right"], bold_rows=(len(rows) - 1,))
    doc.para("OSS-ilmoitukseen ilmoitetut myynnit eivät sisälly kotimaan kausiveroilmoitukseen. Aiemman kauden korjaukset "
             "tehdään myöhemmällä OSS-ilmoituksella korjattavan kauden ja kulutusjäsenvaltion tiedoin.", 7.5, color=GREY)
    doc.save()


# --------------------------------------------------------------------------
# Inventory
# --------------------------------------------------------------------------

def inventory_doc(path, M):
    inv = M.docs["inventory"]
    doc = Doc(path, "Inventaariolista 31.12.2024")
    doc.band("INVENTAARIO 31.12.2024 · Kaarnatien varasto", 10, fill=colors.Color(0.4, 0.25, 0.1))
    doc.kv([("Laskijat", "Liisa Kärkkäinen, Tuomas Rautio"), ("Laskettu", "31.12.2024 klo 10–14 (fyysinen laskenta)"),
            ("Arvostus", "hankintameno (alv 0), FIFO, viimeisin ostohinta")])
    rows = [[k, name, q, fi(u), fi(v)] for k, name, q, u, v in inv["rows"]]
    rows.append(["", "VARASTO YHTEENSÄ (laskettu)", "", "", fi(inv["count"])])
    doc.table(["SKU", "NIMIKE", "KPL", "YKSIKKÖHINTA", "ARVO EUR"], rows, [0.08, 0.52, 0.1, 0.14, 0.16],
              ["left", "left", "right", "right", "right"], bold_rows=(len(rows) - 1,), zebra=True)
    doc.para("Huom: Kiinasta tilatut 600 mukia (HF-24-1107, lastattu Ningbossa 10.12.2024, FOB) ovat merellä eivätkä sisälly "
             "laskentaan. Laskettuihin mukeihin sisältyy vain aiempi varasto.", 7.8)
    doc.para("Hävitetyt tuotteet (ks. hävityspöytäkirja 30.12.) on poistettu hyllystä ennen laskentaa.", 7.8)
    doc.save()


def destroyed_doc(path, M):
    inv = M.docs["inventory"]
    doc = Doc(path, "Hävityspöytäkirja 30.12.2024")
    doc.text("HÄVITYSPÖYTÄKIRJA", 14, bold=True)
    doc.text(f"{CO['name']} · {fdate(D.DESTROYED['date'])}", 9)
    doc.space(4)
    rows = [[k, prod(k), q, why, fi(u), fi(v)] for k, q, why, u, v in inv["destroyed"]]
    rows.append(["", "YHTEENSÄ", "", "", "", fi(inv["destroyed_total"])])
    doc.table(["SKU", "TUOTE", "KPL", "SYY", "HANKINTAHINTA", "ARVO"], rows, [0.07, 0.3, 0.07, 0.3, 0.13, 0.13],
              ["left", "left", "right", "left", "right", "right"], bold_rows=(len(rows) - 1,))
    doc.para("Tuotteet toimitettu biojäteastiaan / pahvinkeräykseen. Hävityksen todisti Tuomas Rautio.\n\n"
             "Allekirjoitukset: Liisa Kärkkäinen   Tuomas Rautio", 8.5)
    doc.save()


# --------------------------------------------------------------------------
# Registry
# --------------------------------------------------------------------------

def registry(M):
    """(filename, renderer) in pack order."""
    R = [
        ("01 Tiliote 12-2024 - Merituuli Pankki.pdf", lambda p: bank_statement(p, M, "2024-12", 12)),
        ("02 Tiliote 01-2025 - Merituuli Pankki.pdf", lambda p: bank_statement(p, M, "2025-01", 1)),
        ("03 Saldoluettelo 30.11.2024 - edellinen tilitoimisto.pdf", lambda p: opening_tb(p, M)),
        ("04 Yrityskortin lasku 12-2024 - Merituuli Business Mastercard.pdf", lambda p: card_invoice(p, M, "2024-12")),
        ("05 Yrityskortin lasku 01-2025 - Merituuli Business Mastercard.pdf", lambda p: card_invoice(p, M, "2025-01")),
        ("10 Sales report 12-2024 - verkkokauppa.pdf", lambda p: web_report(p, M, "2024-12")),
        ("11 Sales report 01-2025 - verkkokauppa.pdf", lambda p: web_report(p, M, "2025-01")),
        ("12 EU distance sales export - OSS-kertymä.pdf", lambda p: eu_export(p, M)),
        ("13 Paytrail tilitysraportti 12-2024.pdf", lambda p: paytrail_report(p, M, "2024-12")),
        ("14 Paytrail tilitysraportti 01-2025.pdf", lambda p: paytrail_report(p, M, "2025-01")),
        ("15 Sähköposti - Paytrail tilityksen pidätys 23.12.pdf", lambda p: paytrail_hold_email(p, M)),
        ("16 Klarna settlement report 12-2024.pdf", lambda p: klarna_report(p, M, "2024-12")),
        ("17 Klarna settlement report 01-2025.pdf", lambda p: klarna_report(p, M, "2025-01")),
        ("18 Nexi tilitysraportti - joulutori 12-2024.pdf", lambda p: nexi_report(p, M)),
        ("19 MobilePay tilitysraportti - joulutori 12-2024.pdf", lambda p: mobilepay_report(p, M)),
        ("20 Kassan Z-raportti - joulutori 13.-22.12.2024.pdf", lambda p: z_report(p, M)),
        ("21 Amazon.de Abrechnung 12-2024.pdf", lambda p: amazon_settlement(p, M, "2024-12", "de")),
        ("22 Amazon.de settlement 01-2025.pdf", lambda p: amazon_settlement(p, M, "2025-01", "en")),
        ("23 Amazon Services Europe - fee invoice 12-2024.pdf", lambda p: amazon_invoice(p, M, "2024-12")),
        ("24 Amazon Services Europe - fee invoice 01-2025.pdf", lambda p: amazon_invoice(p, M, "2025-01")),
        ("25 Myyntilasku 2024-118 - Pohjoisen Insinööritoimisto Oy.pdf", lambda p: b2b_invoice(p, M)),
        ("26 Sähköposti - Pohjoisen Insinööritoimisto maksu.pdf", lambda p: b2b_email(p, M)),
        ("27 Lahjakorttiraportti 12-2024-01-2025.pdf", lambda p: giftcard_report(p, M)),
        ("28 Palautuslomake W-24-1402.pdf", lambda p: return_form(p, M)),
        ("29 Reklamation W-24-1401 - kadonnut paketti (SE).pdf", lambda p: swedish_complaint(p, M)),
        ("30 Ostolasku M-24-1187 - Pohjolan Makeistukku Oy.pdf", lambda p: purchase_invoice(p, M, "mt-1187")),
        ("31 Ostolasku M-24-1229 - Pohjolan Makeistukku Oy.pdf", lambda p: purchase_invoice(p, M, "mt-1229")),
        ("32 Ostolasku M-25-0042 - Pohjolan Makeistukku Oy.pdf", lambda p: purchase_invoice(p, M, "mt-0042")),
        ("33 Ostolasku K-2025-003 - Kustannus Kuusamo Oy.pdf", lambda p: purchase_invoice(p, M, "ku-003")),
        ("34 Ostolasku K-2025-011 - Kustannus Kuusamo Oy.pdf", lambda p: purchase_invoice(p, M, "ku-011")),
        ("35 Ostolasku 3391 - Oulun Pakkaustarvike Oy.pdf", lambda p: purchase_invoice(p, M, "pk-3391")),
        ("36 Sähköposti - Tuomas Rautio (lasku 3391 ja Amazon).pdf", lambda p: tuomas_email(p, M)),
        ("37 Ostolasku LK-241231-0877 - Lokerikko Oy.pdf", lambda p: purchase_invoice(p, M, "lk-1224")),
        ("38 Ostolasku LK-250131-0911 - Lokerikko Oy.pdf", lambda p: purchase_invoice(p, M, "lk-0131")),
        ("39 Posti lasku 12-2024 (päivätty 3.1.2025).pdf", lambda p: posti_invoice(p, M)),
        ("40 Posti hyvityslasku - kadonnut lähetys.pdf", lambda p: posti_credit(p, M)),
        ("41 Invoice TT-5521 - Thistle & Toffee Ltd (GBP).pdf", lambda p: uk_invoice(p, M)),
        ("42 Tullauspäätös 10.12.2024 - Tulli (UK).pdf", lambda p: customs_decision(p, M, "uk")),
        ("43 Huolintalasku PH-24-3318 - Pohjanlahden Huolinta Oy.pdf", lambda p: forwarder_invoice(p, M, "uk")),
        ("44 Commercial invoice HF-24-1107 - Hengfeng Porcelain (USD).pdf", lambda p: china_invoice(p, M)),
        ("45 Tullauspäätös 08.01.2025 - Tulli (CN).pdf", lambda p: customs_decision(p, M, "cn")),
        ("46 Huolintalasku PH-25-0042 - Pohjanlahden Huolinta Oy.pdf", lambda p: forwarder_invoice(p, M, "cn")),
        ("47 Shopify invoices 12-2024 ja 01-2025.pdf", lambda p: saas_pack(p, M, "shopify")),
        ("48 Mailchimp receipts 12-2024 ja 01-2025.pdf", lambda p: saas_pack(p, M, "mailchimp")),
        ("49 Meta ads receipts 12-2024-01-2025.pdf", lambda p: saas_pack(p, M, "meta")),
        ("50 Google Ads receipts 12-2024-01-2025.pdf", lambda p: saas_pack(p, M, "google")),
        ("51 Kirjuri Pilvi Oy - kuitit 12-2024 ja 01-2025.pdf", lambda p: saas_pack(p, M, "kirjuri")),
        ("52 Kuitti 11.12 - K-Rauta Liminganportti (kuva).jpg", lambda p: krauta_photo(p)),
        ("53 Kuitti 13.12 - Tokmanni Kaakkuri (kuva).jpg", lambda p: tokmanni_photo(p)),
        ("54 Amazon.de tilausvahvistus 12.1.2025 (yksityinen).pdf", lambda p: amazon_private_order(p, M)),
        ("60 Palkkalaskelma 12-2024 - Nieminen Veera.pdf", lambda p: payslip_doc(p, M, "P1")),
        ("61 Palkkalaskelma 01-2025 - Nieminen Veera.pdf", lambda p: payslip_doc(p, M, "P2")),
        ("62 Palkkalaskelma 02-2025 lopputili - Nieminen Veera.pdf", lambda p: payslip_doc(p, M, "P3")),
        ("63 Tuntiraportti 12-2024 - Nieminen Veera.pdf", lambda p: hours_report(p, M)),
        ("64 Tulorekisteri - palkkatietoilmoitukset.pdf", lambda p: tulorekisteri(p, M)),
        ("65 TyEL-lasku 12-2024 - Elo.pdf", lambda p: elo_tyel(p, M)),
        ("66 YEL-lasku 12-2024 - Elo - Kärkkäinen Liisa.pdf", lambda p: elo_yel(p, M, "liisa")),
        ("67 YEL-lasku 12-2024 - Elo - Rautio Tuomas.pdf", lambda p: elo_yel(p, M, "tuomas")),
        ("68 Työttömyysvakuutusmaksu Q4-2024 - Työllisyysrahasto.pdf", lambda p: tvr_invoice(p, M)),
        ("69 Tapaturmavakuutus 2025 - Revontuli.pdf", lambda p: accident_invoice(p, M)),
        ("70 OmaVero - verotilin tapahtumat 12-2024-01-2025.pdf", lambda p: omavero(p, M)),
        ("71 OmaVero - OSS-ilmoitus Q4-2024.pdf", lambda p: oss_return(p, M)),
        ("80 Inventaariolista 31.12.2024.pdf", lambda p: inventory_doc(p, M)),
        ("81 Hävityspöytäkirja 30.12.2024.pdf", lambda p: destroyed_doc(p, M)),
    ]
    return R
