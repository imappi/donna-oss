"""Derives every number of the Karkkiaitta pack from data.py.

Output of build_model(): a Model with
  - journal: list of Entry (every booking the answer key states)
  - bank: {"2024-12": [BankLine], "2025-01": [BankLine]} with running balances
  - docs: per-document computed content used by render.py
  - figures: section-C month figures (computed FROM the journal, never typed)

check_model() raises CheckError on anything that does not reconcile.
"""

from __future__ import annotations

import datetime as dt
from collections import OrderedDict, defaultdict
from dataclasses import dataclass, field
from decimal import ROUND_HALF_UP, Decimal

from . import data as D

ZERO = Decimal("0.00")
CENT = Decimal("0.01")


class CheckError(Exception):
    pass


def m(x) -> Decimal:
    return Decimal(str(x)).quantize(CENT, rounding=ROUND_HALF_UP)


def pct(x) -> Decimal:
    return Decimal(str(x))


def d(s: str) -> dt.date:
    return dt.date.fromisoformat(s)


def month_of(s) -> str:
    if isinstance(s, dt.date):
        return s.strftime("%Y-%m")
    return s[:7]


def vat_from_gross(gross: Decimal, rate) -> Decimal:
    r = pct(rate)
    return m(gross * r / (Decimal(100) + r))


def vat_from_net(net: Decimal, rate) -> Decimal:
    return m(net * pct(rate) / Decimal(100))


def rate_key(rate) -> str:
    r = pct(rate).normalize()
    s = format(r, "f")
    return s


# --------------------------------------------------------------------------
# Accounts
# --------------------------------------------------------------------------

ACCOUNTS = OrderedDict([
    ("1500", "Tavaravarasto"),
    ("1700", "Myyntisaamiset"),
    ("1710", "Paytrail-saamiset (maksunvälitys)"),
    ("1711", "Klarna-saamiset"),
    ("1712", "Amazon-saamiset"),
    ("1713", "Nexi-korttimaksusaamiset"),
    ("1714", "MobilePay-saamiset"),
    ("1720", "Paytrail-pidätys (varaus)"),
    ("1760", "ALV-saamiset (kotimaan ostot)"),
    ("1761", "Käännetyn ALV:n vähennys"),
    ("1762", "Maahantuonnin ALV:n vähennys"),
    ("1780", "Siirtosaamiset (ennakkoon maksetut kulut)"),
    ("1790", "Ennakkomaksut tavaraostoista"),
    ("1795", "Saaminen osakkaalta"),
    ("1910", "Pankkitili Merituuli"),
    ("2000", "Osakepääoma"),
    ("2370", "Tilikauden tulos 1.1.-30.11.2024 (avaava)"),
    ("2871", "Ennakonpidätysvelka"),
    ("2872", "Sairausvakuutusmaksuvelka (sava)"),
    ("2873", "TyEL-velka"),
    ("2874", "Työttömyysvakuutusmaksuvelka"),
    ("2875", "Palkkavelka"),
    ("2876", "Lomapalkkavelka (lomakorvaus)"),
    ("2878", "Lahjakorttivelka"),
    ("2879", "Velka osakkaalle"),
    ("2880", "Saadut ennakot (maksettu, toimittamatta)"),
    ("2881", "Asiakkaiden liikasuoritukset"),
    ("2890", "Ostovelat"),
    ("2895", "Yrityskorttivelka"),
    ("2920", "Siirtovelat (jaksotetut sivukulut)"),
    ("2936", "Käännetty ALV-velka, palvelut EU:n ulkopuolelta"),
    ("2937", "Käännetty ALV-velka, palvelut EU:sta"),
    ("2938", "Maahantuonnin ALV-velka"),
    ("2939", "ALV-velka, kotimaan myynti"),
    ("2941", "ALV-tilitysvelka (Verohallinto)"),
    ("2945", "OSS-ALV-velka (Ruotsi, Saksa)"),
    ("3000", "Myynti 25,5 %"),
    ("3010", "Myynti 14 % (makeiset, juomat)"),
    ("3015", "Myynti 14 % (kirjat, 2025-)"),
    ("3020", "Myynti 10 % (kirjat, -2024)"),
    ("3060", "EU-etämyynti Suomen ALV:lla (ennen kynnyksen ylitystä)"),
    ("3100", "OSS-myynti Ruotsi"),
    ("3110", "OSS-myynti Saksa"),
    ("3990", "Vahingonkorvaukset (ALV:n ulkopuolinen)"),
    ("4000", "Ostot 14 % (makeiset, juomat)"),
    ("4005", "Pantit (ALV:n ulkopuolinen)"),
    ("4010", "Ostot kirjat"),
    ("4100", "Maahantuontiostot (tavara)"),
    ("4110", "Tuontirahdit, tullit ja tuontikulut"),
    ("4200", "Pakkaustarvikkeet"),
    ("4300", "Lähtevät rahdit"),
    ("4400", "Varaston muutos"),
    ("5000", "Palkat"),
    ("5010", "Lomakorvaukset"),
    ("6130", "TyEL-maksut"),
    ("6410", "Sairausvakuutusmaksut (sava)"),
    ("6420", "Työttömyysvakuutusmaksut"),
    ("6430", "Tapaturmavakuutus"),
    ("6700", "Markkinointi ja mainonta"),
    ("6710", "Markkinapaikan palkkiot (Amazon)"),
    ("6720", "Verkkokauppa-alusta (Shopify)"),
    ("6730", "Maksunvälityksen palkkiot"),
    ("6740", "Ohjelmistot"),
    ("6800", "Kalusto ja pienhankinnat"),
    ("6900", "Pankki- ja maksuliikennekulut"),
    ("7800", "Luottotappiot"),
    ("8900", "Kurssierot"),
    ("8910", "Veron viivästyskorko"),
])

DOM_SALE_ACCT = {("candy", "14"): "3010", ("drink", "14"): "3010", ("book", "10"): "3020",
                 ("book", "14"): "3015", ("mug", "25.5"): "3000", ("freight", "25.5"): "3000"}
OSS_ACCT = {"SE": "3100", "DE": "3110"}

# VAT tags on posting lines -> which field of the return / OSS return
#   ("sale", rate)          domestic sale output tax (incl. advances)        -> Finnish return
#   ("rc_noneu", rate)      reverse charge, services from outside the EU     -> Finnish return, "vero kotimaan myynnistä" 25,5 %
#   ("rc_eu_serv", rate)    reverse charge, services from EU                 -> Finnish return
#   ("import", rate)        import VAT, goods from outside EU                -> Finnish return
#   ("input", kind)         deductible tax                                   -> Finnish return
#   ("oss", cc, rate)       OSS                                              -> OSS return (not in Finnish return)


@dataclass
class Line:
    acct: str
    debit: Decimal = ZERO
    credit: Decimal = ZERO
    tag: tuple | None = None
    base: Decimal | None = None      # VAT base belonging to a tagged VAT line (signed like the tax)
    note: str = ""


@dataclass
class Entry:
    date: str
    text: str
    docs: list
    lines: list
    bank: "BankLine | None" = None
    kind: str = "doc"          # "bank" or "doc"
    note: str = ""
    eid: str = ""

    def total(self):
        return sum((l.debit for l in self.lines), ZERO), sum((l.credit for l in self.lines), ZERO)


@dataclass
class BankLine:
    date: str
    kind: str            # e.g. "TILISIIRTO", "SEPA-MAKSU", "KORTTITILITYS"
    party: str
    message: str
    amount: Decimal
    archive: str = ""
    balance: Decimal = ZERO
    entry: Entry | None = None
    seq: int = 0


@dataclass
class Model:
    journal: list = field(default_factory=list)
    bank: dict = field(default_factory=dict)
    docs: dict = field(default_factory=dict)
    figures: dict = field(default_factory=dict)
    opening: dict = field(default_factory=dict)
    notes: list = field(default_factory=list)


class Builder:
    def __init__(self):
        self.M = Model()
        self._bank = []

    # entries -------------------------------------------------------------
    def entry(self, date, text, docs, lines, note=""):
        e = Entry(date=date, text=text, docs=list(docs), lines=[l for l in lines if (l.debit or l.credit)], note=note)
        self.M.journal.append(e)
        return e

    def bank_entry(self, date, kind, party, message, amount, text, docs, lines, note=""):
        amount = m(amount)
        e = self.entry(date, text, docs, lines, note)
        e.kind = "bank"
        bl = BankLine(date=date, kind=kind, party=party, message=message, amount=amount, entry=e)
        e.bank = bl
        self._bank.append(bl)
        # the bank account line itself
        if amount >= 0:
            e.lines.insert(0, Line("1910", debit=amount))
        else:
            e.lines.insert(0, Line("1910", credit=-amount))
        return e


def Dr(acct, amt, tag=None, base=None, note=""):
    return Line(acct, debit=m(amt), tag=tag, base=None if base is None else m(base), note=note)


def Cr(acct, amt, tag=None, base=None, note=""):
    return Line(acct, credit=m(amt), tag=tag, base=None if base is None else m(base), note=note)


# --------------------------------------------------------------------------
# Pricing helpers
# --------------------------------------------------------------------------

def year_of(date) -> str:
    return str(date)[:4]


def fi_rate(cat, date) -> str:
    return D.VAT["FI"][cat][year_of(date)]


def dest_rate(cc, cat) -> str:
    return D.VAT[cc][cat]


def box_components_gross(box_gross: Decimal):
    """Split a gift-box price by component purchase cost. Returns [(product, cat, gross)]."""
    comps = D.GIFT_BOX["components"]
    costs = [pct(D.PRODUCTS[p]["cost"]) for p, _ in comps]
    tot = sum(costs)
    out, acc = [], ZERO
    for i, ((p, cat), c) in enumerate(zip(comps, costs)):
        if i == len(comps) - 1:
            g = box_gross - acc
        else:
            g = m(box_gross * c / tot)
            acc += g
        out.append((p, cat, g))
    return out


def order_parts(lines, price_table=None):
    """lines [(product, qty)] -> list of (label, cat, gross) with boxes split to components."""
    out = []
    for p, q in lines:
        prod = D.PRODUCTS[p]
        price = pct((price_table or {}).get(p, prod["price"]))
        if prod["cat"] == "box":
            for cp, cat, g in box_components_gross(m(price)):
                out.append((f"{prod['name']} / osuus: {D.PRODUCTS[cp]['name']}", cat, m(g * q), p, q))
        else:
            out.append((prod["name"], prod["cat"], m(price * q), p, q))
    return out


def alloc_shipping(ship_gross: Decimal, rate_net: dict):
    """Split a shipping charge across VAT rates so that each rate's shipping NET is
    proportional to the goods' net value at that rate (Vero: jaetaan tavaroiden
    verottomien arvojen suhteessa). rate_net: {rate: net}. Returns {rate: gross}."""
    items = sorted(rate_net.items(), key=lambda kv: -pct(kv[0]))
    weights = [(r, n * (1 + pct(r) / 100)) for r, n in items if n]
    tot = sum(w for _, w in weights)
    out, acc = {}, ZERO
    for i, (r, w) in enumerate(weights):
        if i == len(weights) - 1:
            g = ship_gross - acc
        else:
            g = m(ship_gross * w / tot)
            acc += g
        out[r] = g
    return out


class VatBucket:
    """Accumulates (account, rate) -> gross, then splits to net + VAT."""

    def __init__(self):
        self.g = defaultdict(lambda: ZERO)   # (acct, tagkind, cc, rate) -> gross

    def add(self, acct, kind, cc, rate, gross):
        self.g[(acct, kind, cc, rate_key(rate))] += m(gross)

    def rows(self):
        out = []
        for (acct, kind, cc, rate), gross in sorted(self.g.items()):
            vat = vat_from_gross(gross, rate)
            out.append({"acct": acct, "kind": kind, "cc": cc, "rate": rate, "gross": gross, "vat": vat, "net": gross - vat})
        return out


def price_order(lines, date, cc="FI", taxed_in="FI", ship_gross=ZERO, price_table=None):
    """Price one order. taxed_in "FI" -> Finnish rates by supply year; else destination rates.
    Returns dict with rows [(label, cat, rate, gross, net, vat)], ship split, totals."""
    parts = order_parts(lines, price_table)
    rows = []
    for label, cat, gross, p, q in parts:
        rate = fi_rate(cat, date) if taxed_in == "FI" else dest_rate(taxed_in, cat)
        vat = vat_from_gross(gross, rate)
        rows.append({"label": label, "cat": cat, "rate": rate_key(rate), "gross": gross, "net": gross - vat, "vat": vat,
                     "product": p, "qty": q})
    ship_rows = []
    if ship_gross:
        rn = defaultdict(lambda: ZERO)
        for r in rows:
            rn[r["rate"]] += r["net"]
        for rate, g in alloc_shipping(m(ship_gross), rn).items():
            vat = vat_from_gross(g, rate)
            # shipping follows the goods: use the category of the goods at that rate
            cat = next(r["cat"] for r in rows if r["rate"] == rate)
            ship_rows.append({"label": "Toimitusmaksu", "cat": cat, "rate": rate, "gross": g, "net": g - vat, "vat": vat})
    allrows = rows + ship_rows
    return {"rows": rows, "ship": ship_rows, "gross": sum((r["gross"] for r in allrows), ZERO),
            "net": sum((r["net"] for r in allrows), ZERO), "vat": sum((r["vat"] for r in allrows), ZERO),
            "taxed_in": taxed_in, "cc": cc}


def sales_lines(priced, date, oss_cc=None, pre_threshold_eu=False, sign=1, acct_override=None):
    """Posting lines (credit sales + VAT) for a priced order/aggregate. sign=-1 reverses."""
    out = []
    by = defaultdict(lambda: [ZERO, ZERO])   # (acct, rate, cat) -> [net, vat]
    for r in priced["rows"] + priced["ship"]:
        if oss_cc:
            acct = OSS_ACCT[oss_cc]
        elif pre_threshold_eu:
            acct = "3060"
        else:
            acct = DOM_SALE_ACCT[(r["cat"], r["rate"])]
        if acct_override:
            acct = acct_override
        by[(acct, r["rate"])][0] += r["net"]
        by[(acct, r["rate"])][1] += r["vat"]
    for (acct, rate), (net, vat) in sorted(by.items()):
        if oss_cc:
            vacct, tag = "2945", ("oss", oss_cc, rate)
        else:
            vacct, tag = "2939", ("sale", rate)
        if sign > 0:
            out.append(Cr(acct, net))
            out.append(Cr(vacct, vat, tag=tag, base=net))
        else:
            out.append(Dr(acct, net))
            out.append(Dr(vacct, vat, tag=tag, base=net))
    return out


# --------------------------------------------------------------------------
# Calendar helpers
# --------------------------------------------------------------------------

def days_in(month):
    y, mo = map(int, month.split("-"))
    start = dt.date(y, mo, 1)
    nxt = dt.date(y + (mo == 12), 1 if mo == 12 else mo + 1, 1)
    return [(start + dt.timedelta(n)).isoformat() for n in range((nxt - start).days)]


def spread(total: Decimal, weights):
    tw = sum(weights)
    out, acc = [], ZERO
    idx_last = max(i for i, w in enumerate(weights) if w)
    for i, w in enumerate(weights):
        if i == idx_last:
            out.append(total - acc)
        elif w:
            v = m(total * w / tw)
            out.append(v)
            acc += v
        else:
            out.append(ZERO)
    return out


def in_range(day, a, b):
    return a <= day <= b


# --------------------------------------------------------------------------
# The build
# --------------------------------------------------------------------------

def build_model() -> Model:
    B = Builder()
    M = B.M
    docs = M.docs

    # ---------------- opening balances (30.11.2024) ----------------
    R24, R25 = D.PAYROLL_RATES["2024"], D.PAYROLL_RATES["2025"]
    emp = D.EMPLOYEE
    hourly = pct(emp["hourly"])

    def payslip(p):
        yr = p["paid"][:4]
        rates = D.PAYROLL_RATES[yr]
        base = m(hourly * p["hours"])
        evening = m(hourly * pct(emp["evening_pct"]) / 100 * p["evening"])
        sunday = m(hourly * pct(emp["sunday_pct"]) / 100 * p["sunday"])
        wages = base + evening + sunday
        out = {"key": p["key"], "paid": p["paid"], "period": p["period"], "year": yr, "rates": rates,
               "rows": [("Tuntipalkka", f"{p['hours']} h x {fmt_plain(hourly)}", base)]}
        if p["evening"]:
            out["rows"].append(("Iltalisä 20 % (ma-pe klo 18-)", f"{p['evening']} h x {fmt_plain(m(hourly * pct(emp['evening_pct']) / 100))}", evening))
        if p["sunday"]:
            out["rows"].append(("Sunnuntaityökorotus 100 %", f"{p['sunday']} h x {fmt_plain(hourly)}", sunday))
        out["wages"] = wages
        out["holiday"] = ZERO
        if p.get("final"):
            earned = wages + sum(x["wages"] for x in M.docs.get("_payslips", []))
            out["holiday"] = m(earned * pct(emp["holiday_comp_pct"]) / 100)
            out["holiday_basis"] = earned
            out["rows"].append(("Lomakorvaus 9 % (vuosilomalaki, prosenttiperusteinen)", f"9 % x {fmt_plain(earned)}", out["holiday"]))
        gross = wages + out["holiday"]
        out["gross"] = gross
        out["taxpct"] = emp["taxcard"][yr]
        out["tax"] = m(gross * pct(out["taxpct"]) / 100)
        out["tyel_e"] = m(gross * pct(rates["tyel_employee"]) / 100)
        out["tvr_e"] = m(gross * pct(rates["tvr_employee"]) / 100)
        out["net"] = gross - out["tax"] - out["tyel_e"] - out["tvr_e"]
        out["tyel_r"] = m(gross * pct(rates["tyel_employer"]) / 100)
        out["sava"] = m(gross * pct(rates["sava"]) / 100)
        out["tvr_r"] = m(gross * pct(rates["tvr_employer"]) / 100)
        M.docs.setdefault("_payslips", []).append(out)
        return out

    P = {p["key"]: payslip(p) for p in D.PAYSLIPS}
    docs["payslips"] = P

    def side_costs(amount, rates):
        return (m(amount * pct(rates["tyel_employer"]) / 100), m(amount * pct(rates["sava"]) / 100),
                m(amount * pct(rates["tvr_employer"]) / 100))

    hol_nov = m(P["P1"]["wages"] * pct(emp["holiday_comp_pct"]) / 100)
    hol_nov_sc = side_costs(hol_nov, R25)

    paytrail_nov = sum((pct(a) for _, a in D.PAYTRAIL_NOV_TAIL), ZERO)
    klarna_nov = sum((pct(a) for _, a in D.KLARNA_NOV_TAIL), ZERO)
    opening = OrderedDict()
    opening["1500"] = m(D.OPENING["1500"])
    opening["1710"] = m(paytrail_nov)
    opening["1711"] = m(klarna_nov)
    opening["1712"] = m(D.AMAZON["nov_payout"][1])
    opening["1790"] = m(D.OPENING["1790"])
    opening["1910"] = m(D.OPENING["1910"])
    opening["2000"] = -m(D.OPENING["2000"])
    opening["2873"] = -P["P1"]["tyel_r"]
    opening["2872"] = -P["P1"]["sava"]
    opening["2874"] = -P["P1"]["tvr_r"]
    opening["2875"] = -P["P1"]["wages"]
    opening["2876"] = -hol_nov
    opening["2920"] = -sum(hol_nov_sc, ZERO)
    opening["2890"] = -(m(D.OPENING["2890_makeistukku_nov"]) + m(D.OPENING["2890_posti_nov"]))
    opening["2895"] = -m(D.CARD["nov_invoice_total"])
    opening["2941"] = -(m(D.OPENING["2941_oct"]) + m(D.OPENING["2941_nov"]))
    opening["2370"] = -sum(opening.values(), ZERO)
    M.opening = opening
    docs["opening_detail"] = {
        "2890": [("Pohjolan Makeistukku Oy, lasku M-24-1102 (11/2024)", m(D.OPENING["2890_makeistukku_nov"])),
                 ("Posti Oy, lasku 11/2024", m(D.OPENING["2890_posti_nov"]))],
        "2941": [("ALV 10/2024 (eräpäivä 12.12.2024)", m(D.OPENING["2941_oct"])),
                 ("ALV 11/2024 (eräpäivä 13.1.2025)", m(D.OPENING["2941_nov"]))],
        "1790": [("Hengfeng Porcelain, 30 % ennakko 540,00 USD (maksettu 18.11.2024)", m(D.OPENING["1790"]))],
        "1710": [("Paytrail, myynnit 25.-30.11.2024 (tilitetään 2.12.)", m(paytrail_nov))],
        "1711": [("Klarna, captures 25.-30.11.2024 (maksetaan 5.12.)", m(klarna_nov))],
        "1712": [("Amazon.de, tilitysjakso 17.-30.11.2024 (maksetaan 3.12.)", m(D.AMAZON["nov_payout"][1]))],
        "2875": [("Palkka 25.-30.11.2024, V. Nieminen (brutto, maksetaan 10.12.)", P["P1"]["wages"])],
        "2876": [("Lomakorvausjaksotus 9 % marraskuun palkasta", hol_nov)],
        "2920": [("Lomakorvausjaksotuksen sivukulut (TyEL, sava, TVR 2025 prosentein)", sum(hol_nov_sc, ZERO))],
        "2873": [("TyEL työnantajan osuus, marraskuun palkka", P["P1"]["tyel_r"])],
        "2872": [("Sava, marraskuun palkka", P["P1"]["sava"])],
        "2874": [("TVR työnantajan osuus, marraskuun palkka", P["P1"]["tvr_r"])],
        "2895": [("Yrityskortti, lasku 11/2024 (veloitetaan 10.12.)", m(D.CARD["nov_invoice_total"]))],
    }

    # ---------------- EU distance sales and the threshold ----------------
    cum = pct(D.EU_DISTANCE_SALES_2024_JAN_NOV)
    thr = pct(D.OSS_THRESHOLD)
    crossed = False
    eu_priced = []
    for o in D.EU_ORDERS:
        ship = pct(D.SHIPPING["amazon"]["price"]) if o["ch"] == "amazon" else pct(D.SHIPPING["eu"]["price"])
        prices = D.AMAZON_PRICES if o["ch"] == "amazon" else None
        if o["date"] >= "2025-01-01":
            taxed_in = o["cc"]
        elif crossed:
            taxed_in = o["cc"]
        else:
            fi = price_order(o["lines"], o["date"], o["cc"], "FI", ship, prices)
            if cum + fi["net"] > thr:
                crossed = True
                taxed_in = o["cc"]
                if o["id"] != D.EU_CROSSING_ORDER:
                    raise CheckError(f"threshold crossed by {o['id']}, data says {D.EU_CROSSING_ORDER}")
            else:
                taxed_in = "FI"
        pr = price_order(o["lines"], o["date"], o["cc"], taxed_in, ship, prices)
        cum_before = cum
        if o["date"] < "2025-01-01":
            cum += pr["net"]
        eu_priced.append({"order": o, "priced": pr, "cum_before": cum_before, "cum_after": cum if o["date"] < "2025-01-01" else None})
    if not crossed:
        raise CheckError("EU threshold never crossed")
    docs["eu_orders"] = eu_priced
    docs["eu_total_2024"] = cum

    # ---------------- web shop bulk ----------------
    web = {}
    for month, spec in D.WEB_BULK.items():
        date = month + "-15"
        lines = [(p, q) for p, q in spec["qty"].items() if q]
        goods = price_order(lines, date)
        ship_gross = sum((pct(D.SHIPPING[k]["price"]) * n for k, n in spec["ship"].items()), ZERO)
        pr = price_order(lines, date, ship_gross=m(ship_gross))
        web[month] = {"priced": pr, "ship_gross": m(ship_gross), "goods": goods}
    docs["web"] = web

    adv = []
    for o in D.ADVANCE_ORDERS:
        ship = pct(D.SHIPPING[o["ship"]]["price"])
        adv.append({"order": o, "priced": price_order(o["lines"], o["paid"], ship_gross=ship)})
    docs["advance"] = adv
    ko = D.KLARNA_DEC_ORDER_JAN_SHIP
    kpr = price_order(ko["lines"], ko["shipped"], ship_gross=pct(D.SHIPPING[ko["ship"]]["price"]))
    docs["klarna_special"] = {"order": ko, "priced": kpr}

    # payment-method split of the bulk
    split = {}
    for month in web:
        g = web[month]["priced"]["gross"]
        gc = m(D.GIFTCARD_REDEEMED[month])
        kl = m(D.KLARNA_BULK_GROSS[month])
        split[month] = {"giftcard": gc, "klarna": kl, "paytrail": g - gc - kl}
    docs["web_split"] = split

    # ---------------- Paytrail daily gross ----------------
    pt_daily = OrderedDict()
    for day, a in D.PAYTRAIL_NOV_TAIL:
        pt_daily[day] = {"bulk": m(a), "eu": ZERO, "gc": ZERO, "adv": ZERO, "nov": True}
    for month in ["2024-12", "2025-01"]:
        days = days_in(month)
        vals = spread(split[month]["paytrail"], D.DAY_WEIGHTS[month])
        for day, v in zip(days, vals):
            pt_daily[day] = {"bulk": v, "eu": ZERO, "gc": ZERO, "adv": ZERO, "nov": False}
    for e in eu_priced:
        if e["order"]["ch"] == "web":
            pt_daily[e["order"]["date"]]["eu"] += e["priced"]["gross"]
    for day, a in D.GIFTCARDS_SOLD_WEB:
        pt_daily[day]["gc"] += m(a)
    for a in adv:
        pt_daily[a["order"]["paid"]]["adv"] += a["priced"]["gross"]
    for day, v in pt_daily.items():
        v["total"] = v["bulk"] + v["eu"] + v["gc"] + v["adv"]
    docs["paytrail_daily"] = pt_daily

    # refunds / chargeback priced at ORIGINAL rates
    refunds = []
    for r in D.RETURNS:
        ship = pct(D.SHIPPING[r["ship"]]["price"]) if r["refund_ship"] else ZERO
        taxed_in = "FI" if r["cc"] == "FI" else r["cc"]
        pr = price_order(r["lines"], r["order_date"], r["cc"], taxed_in, ship)
        refunds.append({"ret": r, "priced": pr})
    docs["refunds"] = refunds
    cb = D.PAYTRAIL["chargeback"]
    cbpr = price_order(cb["lines"], cb["order_date"], ship_gross=pct(D.SHIPPING[cb["ship"]]["price"]))
    docs["chargeback"] = {"cb": cb, "priced": cbpr}

    # Paytrail settlements
    fee_pct = pct(D.PAYTRAIL["fee_pct"])
    settlements = []
    for sdate, a, b in D.PAYTRAIL["settlements"]:
        days = [dd for dd in pt_daily if in_range(dd, a, b)]
        gross = sum((pt_daily[dd]["total"] for dd in days), ZERO)
        fee = m(gross * fee_pct / 100)
        refs = [r for r in refunds if in_range(r["ret"]["refund_date"], a, b)]
        ref_amt = sum((r["priced"]["gross"] for r in refs), ZERO)
        cb_here = in_range(cb["notified"], a, b)
        cb_amt = cbpr["gross"] if cb_here else ZERO
        cb_fee = m(cb["fee"]) if cb_here else ZERO
        net = gross - fee - ref_amt - cb_amt - cb_fee
        reserve = m(D.PAYTRAIL["reserve"]["amount"]) if sdate == D.PAYTRAIL["reserve"]["held_on"] else ZERO
        settlements.append({"date": sdate, "from": a, "to": b, "days": days, "gross": gross, "fee": fee,
                            "refunds": refs, "refund_amt": ref_amt, "cb": cb_amt, "cb_fee": cb_fee,
                            "net": net, "reserve": reserve, "paid": net - reserve,
                            "count": sum(1 for _ in days)})
    docs["paytrail_settlements"] = settlements

    # ---------------- Klarna ----------------
    kl_daily = OrderedDict()
    for day, a in D.KLARNA_NOV_TAIL:
        kl_daily[day] = m(a)
    for month in ["2024-12", "2025-01"]:
        for day, v in zip(days_in(month), spread(split[month]["klarna"], D.KLARNA_WEIGHTS[month])):
            kl_daily[day] = v
    kl_daily[ko["shipped"]] += kpr["gross"]
    docs["klarna_daily"] = kl_daily
    kfee = pct(D.KLARNA["fee_pct"])
    kl_pay = []
    for pdate, a, b in D.KLARNA["payouts"]:
        days = [dd for dd in kl_daily if in_range(dd, a, b)]
        gross = sum((kl_daily[dd] for dd in days), ZERO)
        fee = m(gross * kfee / 100)
        kl_pay.append({"date": pdate, "from": a, "to": b, "days": days, "gross": gross, "fee": fee, "net": gross - fee})
    docs["klarna_payouts"] = kl_pay

    # ---------------- Pop-up market ----------------
    pu = D.POPUP
    pu_lines = [(p, q) for p, q in pu["qty"].items()]
    pu_pr = price_order(pu_lines, "2024-12-15")
    day_tot = spread(pu_pr["gross"], pu["day_weights"])
    pu_days = []
    for day, tot, share in zip(pu["days"], day_tot, pu["card_share_pct"]):
        card = m(tot * share / 100)
        pu_days.append({"day": day, "total": tot, "card": card, "mp": tot - card})
    pu_payouts = []
    for pdate, dl in pu["payouts"]:
        rows = [x for x in pu_days if x["day"] in dl]
        card = sum((x["card"] for x in rows), ZERO)
        mp = sum((x["mp"] for x in rows), ZERO)
        cfee = m(card * pct(pu["nexi_fee_pct"]) / 100)
        mfee = m(mp * pct(pu["mobilepay_fee_pct"]) / 100)
        pu_payouts.append({"date": pdate, "days": dl, "card": card, "card_fee": cfee, "mp": mp, "mp_fee": mfee})
    docs["popup"] = {"priced": pu_pr, "days": pu_days, "payouts": pu_payouts}

    # ---------------- Amazon ----------------
    am_orders = [e for e in eu_priced if e["order"]["ch"] == "amazon"]
    rpct = pct(D.AMAZON["referral_pct"])
    fees = []   # (date, kind, amount, order)
    for e in am_orders:
        fees.append((e["order"]["date"], "referral", m(e["priced"]["gross"] * rpct / 100), e["order"]["id"]))
    for dd, a in D.AMAZON["subscription"]:
        fees.append((dd, "subscription", m(a), ""))
    for dd, a in D.AMAZON["ads"]:
        fees.append((dd, "ads", m(a), ""))
    fees.sort()
    am_settle = []
    for a, b, pdate in D.AMAZON["settlements"]:
        os_ = [e for e in am_orders if in_range(e["order"]["date"], a, b)]
        fs = [f for f in fees if in_range(f[0], a, b)]
        sales = sum((e["priced"]["gross"] for e in os_), ZERO)
        fsum = sum((f[2] for f in fs), ZERO)
        am_settle.append({"from": a, "to": b, "paid": pdate, "orders": os_, "fees": fs, "sales": sales,
                          "fee_total": fsum, "net": sales - fsum})
    am_inv = {}
    for month in ["2024-12", "2025-01"]:
        fs = [f for f in fees if month_of(f[0]) == month]
        am_inv[month] = {"fees": fs, "referral": sum((f[2] for f in fs if f[1] == "referral"), ZERO),
                         "subscription": sum((f[2] for f in fs if f[1] == "subscription"), ZERO),
                         "ads": sum((f[2] for f in fs if f[1] == "ads"), ZERO)}
        am_inv[month]["total"] = am_inv[month]["referral"] + am_inv[month]["subscription"] + am_inv[month]["ads"]
    docs["amazon"] = {"orders": am_orders, "fees": fees, "settlements": am_settle, "invoices": am_inv}

    # ---------------- B2B invoice ----------------
    bi = D.B2B_INVOICE
    box_net = m(D.GIFT_BOX["b2b_net"])
    comps = D.GIFT_BOX["components"]
    costs = [pct(D.PRODUCTS[p]["cost"]) for p, _ in comps]
    tot = sum(costs)
    per_box, acc = [], ZERO
    for i, ((p, cat), c) in enumerate(zip(comps, costs)):
        v = box_net - acc if i == len(comps) - 1 else m(box_net * c / tot)
        acc += v if i < len(comps) - 1 else ZERO
        per_box.append((p, cat, v, fi_rate(cat, bi["delivery"])))
    b2b_rows = []
    for p, cat, v, rate in per_box:
        net = v * bi["boxes"]
        b2b_rows.append({"label": f"Joulun Makea Lahjalaatikko, osuus: {D.PRODUCTS[p]['name']}", "cat": cat, "rate": rate_key(rate),
                         "qty": bi["boxes"], "unit": v, "net": m(net), "vat": vat_from_net(m(net), rate)})
    # freight split by goods net per rate
    fr = m(bi["freight_net"])
    rn = defaultdict(lambda: ZERO)
    for r in b2b_rows:
        rn[r["rate"]] += r["net"]
    fr_rows, acc = [], ZERO
    items = sorted(rn.items(), key=lambda kv: -pct(kv[0]))
    totn = sum(rn.values(), ZERO)
    for i, (rate, n) in enumerate(items):
        v = fr - acc if i == len(items) - 1 else m(fr * n / totn)
        acc += v
        cat = next(r["cat"] for r in b2b_rows if r["rate"] == rate)
        fr_rows.append({"label": f"Rahti, osuus {rate.replace('.', ',')} %", "cat": cat, "rate": rate, "qty": 1, "unit": v,
                        "net": v, "vat": vat_from_net(v, rate)})
    gc_total = m(bi["giftcard_value"]) * bi["giftcards"]
    b2b_net = sum((r["net"] for r in b2b_rows + fr_rows), ZERO)
    b2b_vat = sum((r["vat"] for r in b2b_rows + fr_rows), ZERO)
    b2b = {"rows": b2b_rows, "freight": fr_rows, "per_box": per_box, "giftcards": gc_total,
           "net": b2b_net, "vat": b2b_vat, "gross": b2b_net + b2b_vat + gc_total}
    b2b["paid_amount"] = b2b["gross"] + m(bi["overpaid"])
    docs["b2b"] = b2b

    # ---------------- purchases ----------------
    pinv = {}
    for pi in D.PURCHASE_INVOICES:
        rows = []
        for desc, q, unit, rate, kind in pi["lines"]:
            net = m(pct(unit) * q)
            rows.append({"desc": desc, "qty": q, "unit": m(unit), "rate": rate_key(rate), "kind": kind, "net": net,
                         "vat": vat_from_net(net, rate)})
        net = sum((r["net"] for r in rows), ZERO)
        vat = sum((r["vat"] for r in rows), ZERO)
        pinv[pi["key"]] = {"spec": pi, "rows": rows, "net": net, "vat": vat, "gross": net + vat}
    docs["purchases"] = pinv

    pd = D.POSTI_DEC
    prow = []
    freight = ZERO
    for desc, q, unit in pd["lines"]:
        net = m(pct(unit) * q)
        prow.append({"desc": desc, "qty": q, "unit": m(unit), "net": net})
        if not desc.startswith("Lisämaksu"):
            freight += net
    fuel = m(freight * pct(pd["fuel_pct"]) / 100)
    prow.append({"desc": f"Polttoainelisä {pd['fuel_pct'].replace('.', ',')} %", "qty": 1, "unit": fuel, "net": fuel})
    pnet = sum((r["net"] for r in prow), ZERO)
    pvat = vat_from_net(pnet, "25.5")
    docs["posti_dec"] = {"rows": prow, "net": pnet, "vat": pvat, "gross": pnet + pvat}
    pc = D.POSTI_CREDIT
    cfr = m(pc["freight"])
    cfuel = m(cfr * pct(pc["fuel_pct"]) / 100)
    cnet = cfr + cfuel
    cvat = vat_from_net(cnet, "25.5")
    docs["posti_credit"] = {"freight": cfr, "fuel": cfuel, "net": cnet, "vat": cvat, "comp": m(pc["compensation"]),
                            "total": cnet + cvat + m(pc["compensation"])}

    # imports
    uk = D.UK_IMPORT
    uk_gbp = sum((m(pct(u) * q) for _, q, u in uk["invoice"]["lines"]), ZERO)
    uk_eur_inv = m(uk_gbp / pct(uk["ecb_rate_invoice"]))
    uk_eur_bank = m(uk_gbp / pct(uk["bank_rate"]))
    uc = uk["customs"]
    uk_cv = m(uk_gbp / pct(uc["customs_rate"])) + m(uc["freight_to_border"])
    uk_duty = m(uk_cv * pct(uc["duty_pct"]) / 100)
    uk_base = uk_cv + uk_duty + m(uc["freight_inland"])
    uk_ivat = vat_from_net(uk_base, "14")
    uf = uk["forwarder"]
    uk_fvat = vat_from_net(m(uf["clearance_fee"]), "25.5")
    docs["uk"] = {"gbp": uk_gbp, "eur_inv": uk_eur_inv, "eur_bank": uk_eur_bank, "fx": uk_eur_bank - uk_eur_inv,
                  "customs_value": uk_cv, "duty": uk_duty, "base": uk_base, "ivat": uk_ivat,
                  "goods_eur_customs": m(uk_gbp / pct(uc["customs_rate"])),
                  "fwd_vat": uk_fvat, "fwd_total": m(uf["freight"]) + m(uf["clearance_fee"]) + uk_fvat}
    if m(uf["freight"]) != m(uc["freight_to_border"]) + m(uc["freight_inland"]):
        raise CheckError("UK freight split does not add up to the forwarder's freight")

    cn = D.CHINA_IMPORT
    cn_usd = sum((m(pct(u) * q) for _, q, u in cn["invoice"]["lines"]), ZERO)
    if m(cn["advance_usd"]) + m(cn["balance_usd"]) != cn_usd:
        raise CheckError("China advance + balance != invoice")
    cn_bal_inv = m(pct(cn["balance_usd"]) / pct(cn["ecb_rate_invoice"]))
    cn_bal_bank = m(pct(cn["balance_usd"]) / pct(cn["bank_rate"]))
    cn_cost = m(cn["advance_eur"]) + cn_bal_inv
    cc_ = cn["customs"]
    cn_goods_cust = m(cn_usd / pct(cc_["customs_rate"]))
    cn_cv = cn_goods_cust + m(cc_["freight_to_border"])
    cn_duty = m(cn_cv * pct(cc_["duty_pct"]) / 100)
    cn_base = cn_cv + cn_duty + m(cc_["freight_inland"])
    cn_ivat = vat_from_net(cn_base, "25.5")
    cf = cn["forwarder"]
    cn_fvat = vat_from_net(m(cf["clearance_fee"]), "25.5")
    docs["cn"] = {"usd": cn_usd, "bal_inv": cn_bal_inv, "bal_bank": cn_bal_bank, "fx": cn_bal_bank - cn_bal_inv,
                  "cost": cn_cost, "goods_customs": cn_goods_cust, "customs_value": cn_cv, "duty": cn_duty,
                  "base": cn_base, "ivat": cn_ivat, "fwd_vat": cn_fvat,
                  "fwd_total": m(cf["freight"]) + cn_duty + m(cf["clearance_fee"]) + cn_fvat}
    if m(cf["freight"]) != m(cc_["freight_to_border"]) + m(cc_["freight_inland"]):
        raise CheckError("China freight split does not add up")

    # card
    card = {"2024-12": [], "2025-01": []}
    for t in D.CARD["txns"]:
        card[month_of(t[0])].append(t)
    docs["card"] = {mo: {"txns": v, "total": sum((m(t[3]) for t in v), ZERO)} for mo, v in card.items()}

    # accident insurance
    ai = D.ACCIDENT_INSURANCE
    calc = m(pct(ai["estimated_payroll"]) * pct(D.ACCIDENT_INS_RATE) / 100)
    premium = max(calc, m(ai["min_premium"]))
    docs["accident"] = {"calc": calc, "premium": premium, "monthly": m(premium / 12)}

    # YEL
    yel = {}
    for f in D.FOUNDERS:
        yel[f["key"]] = m(pct(f["yel_income"]) * pct(D.YEL_RATE) / 100 / 12)
    docs["yel"] = yel

    # late interest on October VAT
    due = d("2024-12-12")
    paid = d(D.TAX["oct_vat_paid"])
    late_days = (paid - due).days
    interest = m(m(D.OPENING["2941_oct"]) * pct(D.TAX_LATE_INTEREST_2024) / 100 * late_days / 365)
    docs["late_interest"] = {"days": late_days, "amount": interest}

    # =====================================================================
    # JOURNAL
    # =====================================================================
    E, BE = B.entry, B.bank_entry

    # ---- web shop monthly sales entries ----
    for month in ["2024-12", "2025-01"]:
        pr = web[month]["priced"]
        sp = split[month]
        lines = [Dr("1710", sp["paytrail"]), Dr("1711", sp["klarna"]), Dr("2878", sp["giftcard"])]
        lines += sales_lines(pr, month)
        E(f"{month}-{days_in(month)[-1][-2:]}", f"Verkkokaupan kotimaan myynti {month[5:]}/{month[:4]} (toimitetut)",
          ["myyntiraportti " + month], lines,
          note="Myynti toimituspäivän mukaan; maksutavat Paytrail / Klarna / lahjakortti.")

    # gift cards sold (web) -> liability
    gcsum = sum((m(a) for _, a in D.GIFTCARDS_SOLD_WEB), ZERO)
    E("2024-12-31", "Verkkokaupan lahjakorttimyynti 12/2024 (monikäyttöiset, ei ALV:tä)", ["lahjakorttiraportti"],
      [Dr("1710", gcsum), Cr("2878", gcsum)])

    # advance orders (Dec) and their delivery (Jan)
    for a in adv:
        o, pr = a["order"], a["priced"]
        lines = [Dr("1710", pr["gross"])]
        for r in pr["rows"] + pr["ship"]:
            pass
        by = defaultdict(lambda: [ZERO, ZERO])
        for r in pr["rows"] + pr["ship"]:
            by[r["rate"]][0] += r["net"]
            by[r["rate"]][1] += r["vat"]
        for rate, (net, vat) in sorted(by.items()):
            lines.append(Cr("2880", net))
            lines.append(Cr("2939", vat, tag=("sale", rate), base=net))
        E(o["paid"], f"Ennakkomaksu {o['id']} (maksettu {o['paid'][8:10]}.12., toimitus {o['shipped'][8:10]}.1.)",
          ["myyntiraportti 2024-12", "paytrail 2024-12"], lines,
          note="ALV maksun vastaanottohetken verokannalla (kirjat 10 %).")
        dlines = []
        for rate, (net, vat) in sorted(by.items()):
            cat = next(r["cat"] for r in pr["rows"] + pr["ship"] if r["rate"] == rate)
            acct = DOM_SALE_ACCT[(cat, rate)]
            dlines += [Dr("2880", net), Cr(acct, net)]
        E(o["shipped"], f"Ennakkotilauksen {o['id']} toimitus: tuloutus (ALV jo 12/2024)", ["myyntiraportti 2025-01"], dlines)

    # Klarna Dec order shipped Jan -> January sale
    E(ko["shipped"], f"Klarna-tilaus {ko['id']} (tilattu 30.12., toimitettu ja veloitettu 2.1.)", ["myyntiraportti 2025-01", "klarna 2025-01"],
      [Dr("1711", kpr["gross"])] + sales_lines(kpr, ko["shipped"]))

    # EU orders per month
    for month in ["2024-12", "2025-01"]:
        lines = []
        for e in eu_priced:
            o, pr = e["order"], e["priced"]
            if month_of(o["date"]) != month:
                continue
            lines.append(Dr("1710" if o["ch"] == "web" else "1712", pr["gross"]))
            if pr["taxed_in"] == "FI":
                lines += sales_lines(pr, o["date"], pre_threshold_eu=True)
            else:
                lines += sales_lines(pr, o["date"], oss_cc=pr["taxed_in"])
        E(f"{month}-{days_in(month)[-1][-2:]}", f"EU-kuluttajamyynti {month[5:]}/{month[:4]} (verkkokauppa + Amazon.de)",
          ["eu-etämyynti", "myyntiraportti " + month], merge_lines(lines))

    # B2B
    bl = [Dr("1700", b2b["gross"])]
    by = defaultdict(lambda: [ZERO, ZERO])
    for r in b2b["rows"] + b2b["freight"]:
        by[(DOM_SALE_ACCT[(r["cat"], r["rate"])], r["rate"])][0] += r["net"]
        by[(DOM_SALE_ACCT[(r["cat"], r["rate"])], r["rate"])][1] += r["vat"]
    for (acct, rate), (net, vat) in sorted(by.items()):
        bl += [Cr(acct, net), Cr("2939", vat, tag=("sale", rate), base=net)]
    bl.append(Cr("2878", b2b["giftcards"]))
    E(bi["date"], f"Myyntilasku {bi['no']} {D.CUSTOMER_B2B['name']}", ["myyntilasku 2024-118"], bl)

    # Pop-up market
    pl = [Dr("1713", sum((x["card"] for x in pu_days), ZERO)), Dr("1714", sum((x["mp"] for x in pu_days), ZERO))]
    pl += sales_lines(pu_pr, "2024-12-15")
    E("2024-12-22", "Joulutorin myynti 13.-22.12.2024 (kassan Z-raportti)", ["joulutori z-raportti"], pl)

    # Refunds (Jan) at original rates
    for r in refunds:
        ret, pr = r["ret"], r["priced"]
        if ret["cc"] == "FI":
            lines = sales_lines(pr, ret["order_date"], sign=-1)
        else:
            lines = sales_lines(pr, ret["order_date"], oss_cc=ret["cc"], sign=-1)
        lines.append(Cr("1710", pr["gross"]))
        txt = ("Palautus 14 pv: " if ret["kind"] == "return" else "Kadonnut lähetys, hyvitys: ") + ret["id"]
        E(ret["refund_date"], txt + " (alkuperäisen toimituksen verokannoin)", ["paytrail 2025-01", "palautus " + ret["id"]], lines)

    # Chargeback -> credit loss at original rates
    cbl = []
    by = defaultdict(lambda: [ZERO, ZERO])
    for r in cbpr["rows"] + cbpr["ship"]:
        by[r["rate"]][0] += r["net"]
        by[r["rate"]][1] += r["vat"]
    for rate, (net, vat) in sorted(by.items()):
        cbl += [Dr("7800", net), Dr("2939", vat, tag=("sale", rate), base=-net)]
    # sale-tag with negative base: tax reduction on a credit loss (AVL 78 §)
    for l in cbl:
        if l.tag:
            l.base = -abs(l.base)
    cbl += [Cr("1710", cbpr["gross"]), Dr("6730", m(cb["fee"])), Cr("1710", m(cb["fee"]))]
    E(cb["notified"], f"Takaisinveloitus (chargeback) {cb['order']}: luottotappio + käsittelymaksu", ["paytrail 2025-01"], cbl)

    # Amazon fee invoices (monthly)
    for month, inv in am_inv.items():
        base = inv["total"]
        tax = vat_from_net(base, "25.5")
        E(f"{month}-{days_in(month)[-1][-2:]}", f"Amazon Services Europe, myyjän palkkiot {month[5:]}/{month[:4]} (käänn. ALV)",
          [f"amazon lasku {month}"],
          [Dr("6710", inv["referral"] + inv["subscription"]), Dr("6700", inv["ads"]),
           Dr("1761", tax, tag=("input", "rc_eu_serv"), base=base), Cr("2937", tax, tag=("rc_eu_serv", "25.5"), base=base),
           Cr("1712", base)])

    # Purchases (accrual)
    def pinv_lines(p, acct_map):
        lines = []
        for r in p["rows"]:
            acct = acct_map[r["kind"]]
            lines.append(Dr(acct, r["net"]))
            if r["vat"]:
                lines.append(Dr("1760", r["vat"], tag=("input", "domestic"), base=r["net"]))
        return merge_lines(lines)

    amap = {"candy": "4000", "drink": "4000", "deposit": "4005", "book": "4010", "packaging": "4200", "freight": "4300"}
    for key, p in pinv.items():
        s = p["spec"]
        date = s["date"]
        note = ""
        if key == "ku-003":
            date = "2024-12-31"
            note = "Lasku päivätty 2.1.2025, toimitus 19.12.2024: joulukuun ostoksi ja joulukuun ALV-vähennykseksi; 10 % on OIKEA."
        if key == "ku-011":
            note = "Toimitus 8.1.2025: oikea verokanta 14 %. Vähennetään vain laskulla oleva 10 % vero; pyydä hyvitys + uusi lasku."
        E(date, f"Ostolasku {s['no']} {D.SUPPLIERS[s['sup']]['name']}", [f"ostolasku {s['no']}"],
          pinv_lines(p, amap) + [Cr("2890", p["gross"])], note=note)
        if s["paid"] and s["paid"].startswith("private:"):
            _, who, pdate = s["paid"].split(":")
            E(pdate, f"Tuomas Rautio maksoi laskun {s['no']} omalta tililtään", [f"ostolasku {s['no']}", "sähköposti tuomas"],
              [Dr("2890", p["gross"]), Cr("2879", p["gross"])])

    # Posti December (dated 3.1.) -> December
    pdx = docs["posti_dec"]
    E("2024-12-31", f"Posti, lasku {D.POSTI_DEC['no']} (joulukuun lähetykset, päivätty 3.1.2025)", ["posti lasku 12-2024"],
      [Dr("4300", pdx["net"]), Dr("1760", pdx["vat"], tag=("input", "domestic"), base=pdx["net"]), Cr("2890", pdx["gross"])],
      note="Laskutusjakso 1.-31.12.2024: jaksotetaan joulukuulle.")
    pcx = docs["posti_credit"]
    E(D.POSTI_CREDIT["date"], f"Posti, hyvityslasku {D.POSTI_CREDIT['no']} (kadonnut lähetys)", ["posti hyvitys"],
      [Dr("2890", pcx["total"]), Cr("4300", pcx["net"]), Cr("1760", pcx["vat"], tag=("input", "domestic"), base=-pcx["net"]),
       Cr("3990", pcx["comp"])],
      note="Rahdin hyvitys oikaisee ALV-vähennystä; sisällön korvaus on vahingonkorvaus, ei ALV:tä.")

    # UK import
    ukd = docs["uk"]
    E(uk["invoice"]["date"], f"Ostolasku {uk['invoice']['no']} Thistle & Toffee Ltd ({ukd['gbp']} GBP / {uk['ecb_rate_invoice']})",
      ["ostolasku TT-5521"], [Dr("4100", ukd["eur_inv"]), Cr("2890", ukd["eur_inv"])])
    E(uc["date"], "Tulli: maahantuonnin ALV 14 % (UK, tulli 0 % etuuskohtelu)", ["tullauspäätös UK"],
      [Dr("1762", ukd["ivat"], tag=("input", "import"), base=ukd["base"]),
       Cr("2938", ukd["ivat"], tag=("import", "14"), base=ukd["base"])])
    E(uf["date"], f"Pohjanlahden Huolinta, lasku {uf['no']} (rahti UK + tullaus)", ["huolinta PH-24-3318"],
      [Dr("4110", m(uf["freight"]) + m(uf["clearance_fee"])), Dr("1760", ukd["fwd_vat"], tag=("input", "domestic"), base=m(uf["clearance_fee"])),
       Cr("2890", ukd["fwd_total"])])

    # China import
    cnd = docs["cn"]
    E(cn["invoice"]["date"], f"Ostolasku {cn['invoice']['no']} Hengfeng (FOB Ningbo, vaaranvastuu siirtyi 10.12.)",
      ["ostolasku HF-24-1107"],
      [Dr("4100", cnd["cost"]), Cr("1790", m(cn["advance_eur"])), Cr("2890", cnd["bal_inv"])],
      note="Ennakko 540 USD historiallisella kurssilla; loppuosa 1 260 USD laskun päivän kurssilla.")
    E(cc_["date"], "Tulli: maahantuonnin ALV 25,5 % (mukit, tulli 9,0 %)", ["tullauspäätös CN"],
      [Dr("1762", cnd["ivat"], tag=("input", "import"), base=cnd["base"]),
       Cr("2938", cnd["ivat"], tag=("import", "25.5"), base=cnd["base"])])
    E(cf["date"], f"Pohjanlahden Huolinta, lasku {cf['no']} (merirahti, tulli läpilaskutus, tullaus)", ["huolinta PH-25-0042"],
      [Dr("4110", m(cf["freight"]) + cnd["duty"] + m(cf["clearance_fee"])),
       Dr("1760", cnd["fwd_vat"], tag=("input", "domestic"), base=m(cf["clearance_fee"])), Cr("2890", cnd["fwd_total"])])

    # Card purchases (per month, booked from the card invoice)
    for month in ["2024-12", "2025-01"]:
        lines = []
        for t in card[month]:
            date, merch, desc, eur, orig, kind = t
            eur = m(eur)
            if kind in ("shopify", "meta", "google"):
                acct = "6720" if kind == "shopify" else "6700"
                tax = vat_from_net(eur, "25.5")
                lines += [Dr(acct, eur), Dr("1761", tax, tag=("input", "rc_eu_serv"), base=eur),
                          Cr("2937", tax, tag=("rc_eu_serv", "25.5"), base=eur)]
            elif kind == "mailchimp":
                tax = vat_from_net(eur, "25.5")
                lines += [Dr("6700", eur), Dr("1761", tax, tag=("input", "rc_noneu"), base=eur),
                          Cr("2936", tax, tag=("rc_noneu", "25.5"), base=eur)]
            elif kind in ("kirjuri", "krauta", "tokmanni"):
                acct = {"kirjuri": "6740", "krauta": "6800", "tokmanni": "4200"}[kind]
                vat = vat_from_gross(eur, "25.5")
                lines += [Dr(acct, eur - vat), Dr("1760", vat, tag=("input", "domestic"), base=eur - vat)]
            elif kind == "private":
                lines += [Dr("1795", eur, note="Tuomas Rautio, yksityisostos")]
            else:
                raise CheckError(kind)
        tot = docs["card"][month]["total"]
        lines.append(Cr("2895", tot))
        E(f"{month}-{days_in(month)[-1][-2:]}", f"Yrityskortti, ostot {month[5:]}/{month[:4]} (korttilaskun erittely)",
          [f"korttilasku {month}"], merge_lines(lines, keep_tags=True))

    # Accident insurance (prepaid 2025)
    acc_d = docs["accident"]
    E(ai["date"], f"Revontuli, lakisääteinen tapaturmavakuutus 2025 (lasku {ai['no']})", ["vakuutuslasku"],
      [Dr("1780", acc_d["premium"]), Cr("2890", acc_d["premium"])], note="Kohdistuu vuodelle 2025: siirtosaamiseksi.")
    E("2025-01-31", "Tapaturmavakuutus 1/12 tammikuulle", ["vakuutuslasku"],
      [Dr("6430", acc_d["monthly"]), Cr("1780", acc_d["monthly"])])

    # Payroll accruals
    p2, p3 = P["P2"], P["P3"]
    hol_dec = m(p2["wages"] * pct(emp["holiday_comp_pct"]) / 100)
    hol_dec_sc = side_costs(hol_dec, R25)
    E("2024-12-31", "Palkkajaksotus 12/2024 (V. Nieminen, maksetaan 10.1.2025)", ["palkkalaskelma P2", "tuntiraportti"],
      [Dr("5000", p2["wages"]), Cr("2875", p2["wages"]),
       Dr("6130", p2["tyel_r"]), Cr("2873", p2["tyel_r"]), Dr("6410", p2["sava"]), Cr("2872", p2["sava"]),
       Dr("6420", p2["tvr_r"]), Cr("2874", p2["tvr_r"]),
       Dr("5010", hol_dec), Cr("2876", hol_dec),
       Dr("6130", hol_dec_sc[0]), Dr("6410", hol_dec_sc[1]), Dr("6420", hol_dec_sc[2]), Cr("2920", sum(hol_dec_sc, ZERO))],
      note="Maksupäivä 2025 -> vuoden 2025 verokortti ja sivukuluprosentit (sava 1,87 %).")
    hol_prev = hol_nov + hol_dec
    sc_prev = [a + b for a, b in zip(hol_nov_sc, hol_dec_sc)]
    E("2025-01-31", "Palkkajaksotus 01/2025 + lomakorvaus (työsuhde päättyi 31.1., maksetaan 7.2.2025)", ["palkkalaskelma P3"],
      [Dr("5000", p3["wages"]), Dr("2876", hol_prev), Dr("5010", p3["holiday"] - hol_prev), Cr("2875", p3["gross"]),
       Dr("2920", sc_prev[0]), Dr("6130", p3["tyel_r"] - sc_prev[0]), Cr("2873", p3["tyel_r"]),
       Dr("2920", sc_prev[1]), Dr("6410", p3["sava"] - sc_prev[1]), Cr("2872", p3["sava"]),
       Dr("2920", sc_prev[2]), Dr("6420", p3["tvr_r"] - sc_prev[2]), Cr("2874", p3["tvr_r"])])

    # Inventory at 31.12.
    count_val = ZERO
    count_rows = []
    for key, q in D.STOCK_COUNT:
        if key in D.PRODUCTS:
            unit = m(D.PRODUCTS[key]["cost"])
            name = D.PRODUCTS[key]["name"]
        else:
            name, unit = D.STOCK_EXTRA_COST[key][0], m(D.STOCK_EXTRA_COST[key][1])
        v = m(unit * q)
        count_rows.append((key, name, q, unit, v))
        count_val += v
    destroyed = [(k, q, why, m(D.PRODUCTS[k]["cost"]), m(pct(D.PRODUCTS[k]["cost"]) * q)) for k, q, why in D.DESTROYED["lines"]]
    closing_inv = count_val + cnd["cost"]
    inv_change = closing_inv - opening["1500"]
    docs["inventory"] = {"rows": count_rows, "count": count_val, "transit": cnd["cost"], "closing": closing_inv,
                         "opening": opening["1500"], "change": inv_change, "destroyed": destroyed,
                         "destroyed_total": sum((x[4] for x in destroyed), ZERO)}
    if inv_change >= 0:
        il = [Dr("1500", inv_change), Cr("4400", inv_change)]
    else:
        il = [Dr("4400", -inv_change), Cr("1500", -inv_change)]
    E("2024-12-31", "Varaston muutos 31.12.2024 (inventaario + matkalla oleva FOB-tavara)", ["inventaario", "hävityspöytäkirja"], il)

    # =====================================================================
    # BANK LINES
    # =====================================================================

    # Paytrail settlements
    for s in settlements:
        lines = [Dr("6730", s["fee"])]
        if s["reserve"]:
            lines.append(Dr("1720", s["reserve"]))
        clear = s["gross"] - s["refund_amt"] - s["cb"] - s["cb_fee"]
        lines.append(Cr("1710", clear))
        per = f"{s['from'][8:10]}.{s['from'][5:7]}.-{s['to'][8:10]}.{s['to'][5:7]}."
        BE(s["date"], "TILISIIRTO", "PAYTRAIL OYJ", f"TILITYS {D.PAYTRAIL['merchant_id']} {per}", s["paid"],
           f"Paytrail-tilitys {per}" + (" (pidätys 1 000,00)" if s["reserve"] else ""),
           ["paytrail " + month_of(s["date"])] + (["paytrail pidätys"] if s["reserve"] else []), lines)
    rs = D.PAYTRAIL["reserve"]
    BE(rs["released_on"], "TILISIIRTO", "PAYTRAIL OYJ", f"VARAUKSEN VAPAUTUS {D.PAYTRAIL['merchant_id']}", m(rs["amount"]),
       "Paytrail: 23.12. pidätetyn varauksen vapautus", ["paytrail pidätys", "paytrail 2025-01"], [Cr("1720", m(rs["amount"]))])

    for k in kl_pay:
        per = f"{k['from'][8:10]}.{k['from'][5:7]}.-{k['to'][8:10]}.{k['to'][5:7]}."
        BE(k["date"], "SEPA-TILISIIRTO", "KLARNA BANK AB (PUBL)", f"SETTLEMENT {D.KLARNA['merchant_id']} {per}", k["net"],
           f"Klarna-tilitys {per}", ["klarna " + month_of(k["date"])], [Dr("6730", k["fee"]), Cr("1711", k["gross"])])

    for p_ in pu_payouts:
        dl = ", ".join(x[8:10] + "." for x in p_["days"])
        BE(p_["date"], "KORTTITILITYS", "NEXI / NETS", f"TILITYS JOULUTORI {dl}12.", p_["card"] - p_["card_fee"],
           f"Nexi-tilitys {dl}12.", ["nexi raportti"], [Dr("6730", p_["card_fee"]), Cr("1713", p_["card"])])
        BE(p_["date"], "TILISIIRTO", "MOBILEPAY", f"MOBILEPAY TILITYS {dl}12.", p_["mp"] - p_["mp_fee"],
           f"MobilePay-tilitys {dl}12.", ["mobilepay raportti"], [Dr("6730", p_["mp_fee"]), Cr("1714", p_["mp"])])

    ndate, namt = D.AMAZON["nov_payout"]
    BE(ndate, "SEPA-TILISIIRTO", "AMAZON PAYMENTS EUROPE SCA", "AMAZON.DE SETTLEMENT 17.11.-30.11.", m(namt),
       "Amazon.de tilitys 17.-30.11.2024 (avaava saaminen)", ["saldoluettelo"], [Cr("1712", m(namt))])
    for s in am_settle:
        per = f"{s['from'][8:10]}.{s['from'][5:7]}.-{s['to'][8:10]}.{s['to'][5:7]}."
        BE(s["paid"], "SEPA-TILISIIRTO", "AMAZON PAYMENTS EUROPE SCA", f"AMAZON.DE SETTLEMENT {per}", s["net"],
           f"Amazon.de tilitys {per}", ["amazon abrechnung " + month_of(s["from"])], [Cr("1712", s["net"])])

    # B2B payment and refund
    BE(bi["paid"], "TILISIIRTO", D.CUSTOMER_B2B["name"].upper(), f"VIESTI: {bi['paid_message']}", b2b["paid_amount"],
       f"Lasku {bi['no']} maksettu myöhässä, väärä viite + liikasuoritus {bi['overpaid']}",
       ["myyntilasku 2024-118", "sähköposti insinööritoimisto"],
       [Cr("1700", b2b["gross"]), Cr("2881", m(bi["overpaid"]))])
    BE(bi["refund_date"], "TILISIIRTO", D.CUSTOMER_B2B["name"].upper(), "LIIKASUORITUKSEN PALAUTUS LASKU 2024-118",
       -m(bi["overpaid"]), "Liikasuorituksen palautus", ["sähköposti insinööritoimisto"], [Dr("2881", m(bi["overpaid"]))])

    # Supplier payments
    BE("2024-12-05", "E-LASKU", "POHJOLAN MAKEISTUKKU OY", "LASKU M-24-1102", -m(D.OPENING["2890_makeistukku_nov"]),
       "Ostolasku M-24-1102 (11/2024, avaava ostovelka)", ["saldoluettelo"], [Dr("2890", m(D.OPENING["2890_makeistukku_nov"]))])
    BE("2024-12-16", "E-LASKU", "POSTI OY", "LASKU 11/2024", -m(D.OPENING["2890_posti_nov"]),
       "Posti 11/2024 (avaava ostovelka)", ["saldoluettelo"], [Dr("2890", m(D.OPENING["2890_posti_nov"]))])
    for key, p in pinv.items():
        s = p["spec"]
        if s["paid"] and not s["paid"].startswith("private:"):
            BE(s["paid"], "E-LASKU", D.SUPPLIERS[s["sup"]]["name"].upper(), f"VIITE {s['ref']}", -p["gross"],
               f"Ostolasku {s['no']} maksu", [f"ostolasku {s['no']}"], [Dr("2890", p["gross"])])
    BE(D.POSTI_DEC["paid"], "E-LASKU", "POSTI OY", f"VIITE {D.POSTI_DEC['ref']}", -pdx["gross"],
       f"Posti lasku {D.POSTI_DEC['no']} maksu", ["posti lasku 12-2024"], [Dr("2890", pdx["gross"])])

    BE(uk["bank_paid"], "ULKOMAANMAKSU", "THISTLE & TOFFEE LTD", f"INV TT-5521 GBP {fmt_plain(ukd['gbp'])} KURSSI {uk['bank_rate']}",
       -(ukd["eur_bank"] + m(uk["bank_fee"])), "Thistle & Toffee TT-5521 (GBP) + palvelumaksu", ["ostolasku TT-5521"],
       [Dr("2890", ukd["eur_inv"]), Dr("8900", ukd["fx"]), Dr("6900", m(uk["bank_fee"]))],
       note="Kurssiero = pankin kurssi vs. laskun kirjauskurssi.")
    BE(uf["paid"], "E-LASKU", "POHJANLAHDEN HUOLINTA OY", f"VIITE {uf['ref']}", -ukd["fwd_total"],
       f"Huolinta {uf['no']} maksu", ["huolinta PH-24-3318"], [Dr("2890", ukd["fwd_total"])])
    BE(cn["bank_paid"], "ULKOMAANMAKSU", "HENGFENG PORCELAIN TRADING", f"INV HF-24-1107 BALANCE USD {fmt_plain(m(cn['balance_usd']))} KURSSI {cn['bank_rate']}",
       -(cnd["bal_bank"] + m(cn["bank_fee"])), "Hengfeng HF-24-1107 loppuosa (USD) + palvelumaksu", ["ostolasku HF-24-1107"],
       [Dr("2890", cnd["bal_inv"]), Dr("8900", cnd["fx"]), Dr("6900", m(cn["bank_fee"]))])
    BE(cf["paid"], "E-LASKU", "POHJANLAHDEN HUOLINTA OY", f"VIITE {cf['ref']}", -cnd["fwd_total"],
       f"Huolinta {cf['no']} maksu", ["huolinta PH-25-0042"], [Dr("2890", cnd["fwd_total"])])

    # Card invoices
    BE("2024-12-10", "SUORAVELOITUS", "MERITUULI BUSINESS MASTERCARD", f"KORTTILASKU 11/2024 **** {D.CARD['last4']}",
       -m(D.CARD["nov_invoice_total"]), "Yrityskortin lasku 11/2024 (avaava velka)", ["saldoluettelo"],
       [Dr("2895", m(D.CARD["nov_invoice_total"]))])
    BE("2025-01-10", "SUORAVELOITUS", "MERITUULI BUSINESS MASTERCARD", f"KORTTILASKU 12/2024 **** {D.CARD['last4']}",
       -docs["card"]["2024-12"]["total"], "Yrityskortin lasku 12/2024", ["korttilasku 2024-12"],
       [Dr("2895", docs["card"]["2024-12"]["total"])])

    # Payroll payments
    for key in ["P1", "P2"]:
        p = P[key]
        BE(p["paid"], "PALKKA", emp["name"].upper(), f"PALKKA {p['period'][0][8:10]}.{p['period'][0][5:7]}.-{p['period'][1][8:10]}.{p['period'][1][5:7]}.",
           -p["net"], f"Nettopalkka {emp['name']} ({key})", [f"palkkalaskelma {key}"],
           [Dr("2875", p["gross"]), Cr("2871", p["tax"]), Cr("2873", p["tyel_e"]), Cr("2874", p["tvr_e"])])

    # YEL mistake and repayment
    liisa = next(f for f in D.FOUNDERS if f["key"] == "liisa")
    BE("2024-12-05", "E-LASKU", "ELO KESKINÄINEN TYÖELÄKEVAKUUTUSYHTIÖ", "YEL LIISA KÄRKKÄINEN 12/2024", -yel["liisa"],
       "YEL-lasku Liisa Kärkkäinen maksettu yhtiön tililtä (virhe)", ["yel liisa"], [Dr("1795", yel["liisa"])],
       note="YEL on yrittäjän henkilökohtainen maksu; ei yhtiön kulu. Saaminen osakkaalta.")
    BE("2024-12-19", "TILISIIRTO", "LIISA KÄRKKÄINEN", "YEL 12/2024 PALAUTUS", yel["liisa"],
       "Liisa palautti yhtiön maksaman YEL-maksun", ["yel liisa"], [Cr("1795", yel["liisa"])])

    # Taxes
    BE(D.TAX["oct_vat_paid"], "OMA-ALOITTEINEN VERO", "VEROHALLINTO", f"VIITE {D.TAX['ref']}", -m(D.OPENING["2941_oct"]),
       "ALV 10/2024 (eräpäivä 12.12., maksettu myöhässä)", ["omavero tammikuu"], [Dr("2941", m(D.OPENING["2941_oct"]))])
    li = docs["late_interest"]["amount"]
    comb = m(D.OPENING["2941_nov"]) + P["P1"]["tax"] + P["P1"]["sava"] + li
    docs["combined_payment"] = {"alv_nov": m(D.OPENING["2941_nov"]), "tax": P["P1"]["tax"], "sava": P["P1"]["sava"],
                                "interest": li, "total": comb}
    BE(D.TAX["combined_paid"], "OMA-ALOITTEINEN VERO", "VEROHALLINTO", f"VIITE {D.TAX['ref']}", -comb,
       "OmaVero yhdistetty maksu: ALV 11/2024 + ennakonpidätys + sava (12/2024 maksetut palkat) + viivästyskorko",
       ["omavero tammikuu"],
       [Dr("2941", m(D.OPENING["2941_nov"])), Dr("2871", P["P1"]["tax"]), Dr("2872", P["P1"]["sava"]), Dr("8910", li)])

    tyel_dec = P["P1"]["tyel_e"] + P["P1"]["tyel_r"]
    docs["tyel_invoice"] = {"employee": P["P1"]["tyel_e"], "employer": P["P1"]["tyel_r"], "total": tyel_dec, "wages": P["P1"]["gross"]}
    BE("2025-01-20", "E-LASKU", "ELO KESKINÄINEN TYÖELÄKEVAKUUTUSYHTIÖ", "TYEL 12/2024 VIITE 61008452", -tyel_dec,
       "TyEL 12/2024 maksetuista palkoista", ["elo tyel"], [Dr("2873", tyel_dec)])
    tvr_dec = P["P1"]["tvr_e"] + P["P1"]["tvr_r"]
    docs["tvr_invoice"] = {"employee": P["P1"]["tvr_e"], "employer": P["P1"]["tvr_r"], "total": tvr_dec, "wages": P["P1"]["gross"]}
    BE("2025-01-28", "E-LASKU", "TYÖLLISYYSRAHASTO", "TVR 10-12/2024 VIITE 44002187", -tvr_dec,
       "Työttömyysvakuutusmaksut Q4/2024 maksetuista palkoista", ["työllisyysrahasto"], [Dr("2874", tvr_dec)])
    BE(ai["due"], "E-LASKU", "VAKUUTUSOSAKEYHTIÖ REVONTULI", f"VIITE {ai['ref']}", -acc_d["premium"],
       "Tapaturmavakuutus 2025", ["vakuutuslasku"], [Dr("2890", acc_d["premium"])])

    # Tuomas net settlement
    owed = pinv["pk-3391"]["gross"]
    priv = next(m(t[3]) for t in D.CARD["txns"] if t[5] == "private")
    tuomas = next(f for f in D.FOUNDERS if f["key"] == "tuomas")
    docs["tuomas_net"] = {"owed": owed, "private": priv, "net": owed - priv}
    BE(D.TUOMAS_NET_PAID, "TILISIIRTO", "TUOMAS RAUTIO", "KULUKORVAUS NETTO: LASKU 3391 - AMAZON 12.1.", -(owed - priv),
       "Velka Tuomakselle (lasku 3391) kuitattu yksityisostolla (Amazon 12.1.), nettomaksu", ["sähköposti tuomas", "korttilasku 2025-01"],
       [Dr("2879", owed), Cr("1795", priv)])

    # Bank fees
    for dd, txt, a in D.BANK_FEES:
        BE(dd, "PALVELUMAKSU", D.BANK_NAME.upper(), txt.upper(), -m(a), f"Pankin {txt.lower()}", ["tiliote " + month_of(dd)],
           [Dr("6900", m(a))])

    # OSS Q4 payment: Q4 OSS VAT = December OSS tax
    oss_q4 = sum((l.credit - l.debit for e in M.journal for l in e.lines
                  if l.acct == "2945" and e.date <= "2024-12-31"), ZERO)
    docs["oss_q4"] = oss_q4
    BE(D.TAX["oss_paid"], "OMA-ALOITTEINEN VERO", "VEROHALLINTO OSS", f"VIITE {D.TAX['oss_ref']}", -oss_q4,
       "OSS-ilmoitus Q4/2024 maksu (SE + DE)", ["oss q4"], [Dr("2945", oss_q4)])

    # VAT period closings (after all VAT lines of the month exist)
    for month in ["2024-12", "2025-01"]:
        close_vat(B, month)

    # ---------------- bank statements ----------------
    finalize_bank(B)
    M.figures = compute_figures(M)
    return M


def fmt_plain(x: Decimal) -> str:
    return f"{x:.2f}".replace(".", ",")


def merge_lines(lines, keep_tags=True):
    """Merge same-account untagged lines on the same side; keep tagged VAT lines merged per tag."""
    out = OrderedDict()
    for l in lines:
        key = (l.acct, "D" if l.debit else "C", l.tag, l.note)
        if key in out:
            o = out[key]
            o.debit += l.debit
            o.credit += l.credit
            if l.base is not None:
                o.base = (o.base or ZERO) + l.base
        else:
            out[key] = Line(l.acct, l.debit, l.credit, l.tag, l.base, l.note)
    return list(out.values())


def close_vat(B, month):
    M = B.M
    end = f"{month}-{days_in(month)[-1][-2:]}"
    bal = defaultdict(lambda: ZERO)
    for e in M.journal:
        if month_of(e.date) != month:
            continue
        for l in e.lines:
            if l.acct in ("1760", "1761", "1762", "2936", "2937", "2938", "2939"):
                bal[l.acct] += l.debit - l.credit
    lines = []
    for acct in ("2939", "2936", "2937", "2938", "1760", "1761", "1762"):
        v = bal[acct]
        if v > 0:
            lines.append(Cr(acct, v))
        elif v < 0:
            lines.append(Dr(acct, -v))
    due = -sum(bal.values(), ZERO)
    if due >= 0:
        lines.append(Cr("2941", due))
    else:
        lines.append(Dr("2941", -due))
    B.entry(end, f"ALV-kauden {month[5:]}/{month[:4]} päättäminen (tilitettävä vero)", ["alv-laskelma " + month], lines)


def finalize_bank(B):
    M = B.M
    lines = sorted(B._bank, key=lambda b: (b.date, 0 if b.amount >= 0 else 1, b.party, b.message))
    bal = M.opening["1910"]
    by = {"2024-12": [], "2025-01": []}
    seq = 0
    for bl in lines:
        seq += 1
        bal += bl.amount
        bl.balance = bal
        bl.seq = seq
        dd = d(bl.date)
        bl.archive = f"{dd.strftime('%y%m%d')}{7911}{seq:05d}{'A' if bl.amount >= 0 else 'B'}"
        mo = month_of(bl.date)
        if mo not in by:
            raise CheckError(f"bank line outside the period: {bl.date} {bl.party}")
        by[mo].append(bl)
        if dd.weekday() >= 5 or bl.date in HOLIDAYS:
            raise CheckError(f"bank line on a non-banking day: {bl.date} {bl.party} {bl.message}")
    M.bank = by


HOLIDAYS = {"2024-12-06", "2024-12-24", "2024-12-25", "2024-12-26", "2025-01-01", "2025-01-06"}


def compute_figures(M):
    """Section C: every figure derived from journal postings."""
    fig = {}
    for month in ["2024-12", "2025-01"]:
        f = OrderedDict()
        sale = defaultdict(lambda: [ZERO, ZERO])
        oss = defaultdict(lambda: [ZERO, ZERO])
        rc_eu = [ZERO, ZERO]
        rc_noneu = [ZERO, ZERO]
        imp = defaultdict(lambda: [ZERO, ZERO])
        inp = defaultdict(lambda: ZERO)
        acct_mov = defaultdict(lambda: ZERO)
        for e in M.journal:
            if month_of(e.date) != month:
                continue
            is_close = e.text.startswith("ALV-kauden")
            for l in e.lines:
                if not is_close:
                    acct_mov[l.acct] += l.debit - l.credit
                if not l.tag or is_close:
                    continue
                t = l.tag
                signed = l.credit - l.debit
                if t[0] == "sale":
                    sale[t[1]][1] += signed
                    sale[t[1]][0] += l.base if signed >= 0 else -abs(l.base)
                elif t[0] == "oss":
                    oss[(t[1], t[2])][1] += signed
                    oss[(t[1], t[2])][0] += l.base if signed >= 0 else -abs(l.base)
                elif t[0] == "rc_eu_serv":
                    rc_eu[1] += signed
                    rc_eu[0] += l.base
                elif t[0] == "rc_noneu":
                    rc_noneu[1] += signed
                    rc_noneu[0] += l.base
                elif t[0] == "import":
                    imp[t[1]][1] += signed
                    imp[t[1]][0] += l.base
                elif t[0] == "input":
                    inp[t[1]] += l.debit - l.credit
        f["sale"] = dict(sale)
        f["oss"] = dict(oss)
        f["rc_eu"] = rc_eu
        f["rc_noneu"] = rc_noneu
        f["import"] = dict(imp)
        f["input"] = dict(inp)
        dom_255 = sale.get("25.5", [ZERO, ZERO])[1] + rc_noneu[1]
        f["return"] = OrderedDict([
            ("Vero kotimaan myynnistä 25,5 % (sis. EU:n ulkopuolisten palveluostojen käännetty vero)", dom_255),
            ("Vero kotimaan myynnistä 14 %", sale.get("14", [ZERO, ZERO])[1]),
            ("Vero kotimaan myynnistä 10 %", sale.get("10", [ZERO, ZERO])[1]),
            ("Vero tavaraostoista muista EU-maista", ZERO),
            ("Vero palveluostoista muista EU-maista", rc_eu[1]),
            ("Vero tavaroiden maahantuonneista EU:n ulkopuolelta", sum((v[1] for v in imp.values()), ZERO)),
            ("Verokauden vähennettävä vero", sum(inp.values(), ZERO)),
        ])
        out_tax = dom_255 + sale.get("14", [ZERO, ZERO])[1] + sale.get("10", [ZERO, ZERO])[1] + rc_eu[1] + \
            sum((v[1] for v in imp.values()), ZERO)
        f["return"]["Maksettava vero (+) / palautukseen oikeuttava (-)"] = out_tax - sum(inp.values(), ZERO)
        f["return_bases"] = OrderedDict([
            ("Palveluostot muista EU-maista", rc_eu[0]),
            ("Tavaroiden maahantuonnit EU:n ulkopuolelta", sum((v[0] for v in imp.values()), ZERO)),
        ])
        f["acct"] = dict(acct_mov)
        fig[month] = f
    return fig


# --------------------------------------------------------------------------
# Checker
# --------------------------------------------------------------------------

def ytunnus_ok(y):
    base, chk = y.split("-")
    w = [7, 9, 10, 5, 8, 4, 2]
    r = sum(int(a) * b for a, b in zip(base, w)) % 11
    if r == 1:
        return False
    return int(chk) == (0 if r == 0 else 11 - r)


def iban_ok(iban):
    s = iban.replace(" ", "")
    n = int("".join(str(int(c, 36)) for c in s[4:] + s[:4]))
    if n % 97 != 1:
        return False
    if s.startswith("FI"):
        acc = s[4:]
        tot = 0
        for i, ch in enumerate(acc[:13]):
            v = int(ch) * (2 if i % 2 == 0 else 1)
            tot += v // 10 + v % 10
        return (10 - tot % 10) % 10 == int(acc[13])
    return True


def ref_ok(r):
    if r.startswith("RF"):
        n = int("".join(str(int(c, 36)) for c in r[4:] + r[:4]))
        return n % 97 == 1
    w = [7, 3, 1]
    body, chk = r[:-1], int(r[-1])
    s = sum(int(ch) * w[i % 3] for i, ch in enumerate(reversed(body)))
    return (10 - s % 10) % 10 == chk and 4 <= len(r) <= 20


def check_model(M: Model):
    errs = []
    # identifiers
    ys = [D.COMPANY["ytunnus"], D.CUSTOMER_B2B["ytunnus"]] + [s["ytunnus"] for s in D.SUPPLIERS.values() if "ytunnus" in s]
    for y in ys:
        if not ytunnus_ok(y):
            errs.append(f"bad y-tunnus {y}")
    if D.COMPANY["vat"] != "FI" + D.COMPANY["ytunnus"].replace("-", ""):
        errs.append("company VAT number != FI + y-tunnus")
    ibans = [D.COMPANY["iban"], D.CUSTOMER_B2B["iban"], D.EMPLOYEE["iban"]] + [f["iban"] for f in D.FOUNDERS] + \
        [s["iban"] for s in D.SUPPLIERS.values() if "iban" in s]
    for i in ibans:
        if not iban_ok(i):
            errs.append(f"bad IBAN {i}")
    if D.COMPANY["iban_display"].replace(" ", "") != D.COMPANY["iban"]:
        errs.append("iban_display mismatch")
    refs = [D.B2B_INVOICE["ref"], D.TAX["ref"], D.TAX["oss_ref"], D.ACCIDENT_INSURANCE["ref"], D.POSTI_DEC["ref"],
            D.UK_IMPORT["forwarder"]["ref"], D.CHINA_IMPORT["forwarder"]["ref"]] + \
        [p["ref"] for p in D.PURCHASE_INVOICES] + [y["ref"] for y in D.YEL_INVOICES]
    for r in refs:
        if not ref_ok(r):
            errs.append(f"bad reference number {r}")
    # journal balances
    for e in M.journal:
        dsum, csum = e.total()
        if dsum != csum:
            errs.append(f"unbalanced entry {e.date} {e.text}: D {dsum} C {csum}")
        for l in e.lines:
            if l.acct not in ACCOUNTS:
                errs.append(f"unknown account {l.acct} in {e.text}")
            if l.debit < 0 or l.credit < 0:
                errs.append(f"negative amount in {e.text} {l.acct}")
            if l.tag and l.tag[0] in ("sale", "oss", "rc_eu_serv", "rc_noneu", "import"):
                rate = l.tag[-1]
                tax = l.credit - l.debit
                if l.base is None:
                    errs.append(f"VAT line without base {e.text}")
                elif abs(vat_from_net(abs(l.base), rate) - abs(tax)) > Decimal("0.05") * max(1, len([1])):
                    # aggregated lines may carry per-line rounding; tolerate a few cents, flag bigger drift
                    if abs(vat_from_net(abs(l.base), rate) - abs(tax)) > Decimal("0.10"):
                        errs.append(f"VAT/base drift {e.text} {l.acct} base {l.base} tax {tax} rate {rate}")
    # opening TB balances
    if sum(M.opening.values(), ZERO) != ZERO:
        errs.append("opening TB does not balance")
    # bank: statement arithmetic + every line has one entry + entry 1910 == bank amount
    bal = M.opening["1910"]
    for mo in ["2024-12", "2025-01"]:
        for bl in M.bank[mo]:
            bal += bl.amount
            if bal != bl.balance:
                errs.append(f"running balance broken at {bl.date}")
            net1910 = sum((l.debit - l.credit for l in bl.entry.lines if l.acct == "1910"), ZERO)
            if net1910 != bl.amount:
                errs.append(f"bank entry 1910 != bank amount {bl.date} {bl.message}")
    # 1910 GL == statement closing
    gl1910 = M.opening["1910"] + sum((l.debit - l.credit for e in M.journal for l in e.lines if l.acct == "1910"), ZERO)
    if gl1910 != M.bank["2025-01"][-1].balance:
        errs.append(f"GL 1910 {gl1910} != statement closing {M.bank['2025-01'][-1].balance}")
    if any(e.kind != "bank" and any(l.acct == "1910" for l in e.lines) for e in M.journal):
        errs.append("a non-bank entry touches 1910")
    # clearing accounts that must be exactly zero at 31.1.
    bals = balances(M, "2025-01-31")
    for acct in ("1720", "1795", "2881", "2879", "1790"):
        if bals.get(acct, ZERO) != ZERO:
            errs.append(f"{acct} {ACCOUNTS[acct]} should be 0 at 31.1., is {bals.get(acct)}")
    # 2880 advances: zero at 31.1., equal to advance nets at 31.12.
    if bals.get("2880", ZERO) != ZERO:
        errs.append("2880 not cleared")
    # payroll liability at 31.1. equals P3 payslip
    P = M.docs["payslips"]
    if -bals.get("2875", ZERO) != P["P3"]["gross"]:
        errs.append(f"2875 {bals.get('2875')} != P3 gross {P['P3']['gross']}")
    if bals.get("2876", ZERO) != ZERO or bals.get("2920", ZERO) != ZERO:
        errs.append(f"holiday accruals not cleared: 2876 {bals.get('2876')} 2920 {bals.get('2920')}")
    # withholding at 31.1. = P2 withholding ; sava = P2 + P3 ; TyEL = P2 e+r + P3 r ; TVR = P2 e+r + P3 r
    exp = {"2871": P["P2"]["tax"], "2872": P["P2"]["sava"] + P["P3"]["sava"],
           "2873": P["P2"]["tyel_e"] + P["P2"]["tyel_r"] + P["P3"]["tyel_r"],
           "2874": P["P2"]["tvr_e"] + P["P2"]["tvr_r"] + P["P3"]["tvr_r"]}
    for a, v in exp.items():
        if -bals.get(a, ZERO) != v:
            errs.append(f"{a} at 31.1. {-bals.get(a, ZERO)} expected {v}")
    # payslip arithmetic
    for p in P.values():
        if p["gross"] - p["tax"] - p["tyel_e"] - p["tvr_e"] != p["net"]:
            errs.append(f"payslip {p['key']} does not add up")
        if sum((r[2] for r in p["rows"]), ZERO) != p["gross"]:
            errs.append(f"payslip {p['key']} rows != gross")
    # platform receivables at 31.1. equal unsettled tails
    pt = M.docs["paytrail_daily"]
    tail = sum((v["total"] for dd, v in pt.items() if dd >= "2025-01-27"), ZERO)
    if bals.get("1710", ZERO) != tail:
        errs.append(f"1710 at 31.1. {bals.get('1710')} != unsettled Paytrail 27.-31.1. {tail}")
    kt = sum((v for dd, v in M.docs["klarna_daily"].items() if dd >= "2025-01-27"), ZERO)
    if bals.get("1711", ZERO) != kt:
        errs.append(f"1711 {bals.get('1711')} != Klarna tail {kt}")
    for a in ("1713", "1714", "1700"):
        if bals.get(a, ZERO) != ZERO:
            errs.append(f"{a} not cleared at 31.1.: {bals.get(a)}")
    am = M.docs["amazon"]
    am_tail = sum((e["priced"]["gross"] for e in am["orders"] if e["order"]["date"] >= "2025-01-26"), ZERO) - \
        sum((f[2] for f in am["fees"] if f[0] >= "2025-01-26"), ZERO)
    if bals.get("1712", ZERO) != am_tail:
        errs.append(f"1712 {bals.get('1712')} != Amazon tail {am_tail}")
    # Paytrail settlement arithmetic
    for s in M.docs["paytrail_settlements"]:
        if s["gross"] - s["fee"] - s["refund_amt"] - s["cb"] - s["cb_fee"] - s["reserve"] != s["paid"]:
            errs.append(f"Paytrail settlement {s['date']} does not reconcile")
    # web shop report: payment methods == gross
    for mo, sp in M.docs["web_split"].items():
        if sp["paytrail"] + sp["klarna"] + sp["giftcard"] != M.docs["web"][mo]["priced"]["gross"]:
            errs.append(f"web split {mo}")
        if sp["paytrail"] <= 0:
            errs.append(f"web split {mo}: paytrail not positive")
    # gift card roll-forward
    gc_bal = -bals.get("2878", ZERO)
    gc_exp = sum((m(a) for _, a in D.GIFTCARDS_SOLD_WEB), ZERO) + M.docs["b2b"]["giftcards"] - \
        sum((m(v) for v in D.GIFTCARD_REDEEMED.values()), ZERO)
    if gc_bal != gc_exp:
        errs.append(f"gift card liability {gc_bal} != {gc_exp}")
    # purchase invoices
    for p in M.docs["purchases"].values():
        if p["net"] + p["vat"] != p["gross"]:
            errs.append(f"purchase {p['spec']['no']} net+vat")
    # VAT closing: 2941 at 31.1. = Dec ALV + Jan ALV (Oct+Nov paid)
    dec_due = M.figures["2024-12"]["return"]["Maksettava vero (+) / palautukseen oikeuttava (-)"]
    jan_due = M.figures["2025-01"]["return"]["Maksettava vero (+) / palautukseen oikeuttava (-)"]
    if -bals.get("2941", ZERO) != dec_due + jan_due:
        errs.append(f"2941 {-bals.get('2941', ZERO)} != Dec {dec_due} + Jan {jan_due}")
    for a in ("1760", "1761", "1762", "2936", "2937", "2938", "2939"):
        for mo_end in ("2024-12-31", "2025-01-31"):
            if balances(M, mo_end).get(a, ZERO) != ZERO:
                errs.append(f"VAT account {a} not closed at {mo_end}")
    # OSS liability at 31.1. equals January OSS tax (incl. the SE correction)
    jan_oss = sum((v[1] for v in M.figures["2025-01"]["oss"].values()), ZERO)
    if -bals.get("2945", ZERO) != jan_oss:
        errs.append(f"2945 {-bals.get('2945')} != Jan OSS {jan_oss}")
    # bank closing positive and plausible
    for mo in ("2024-12", "2025-01"):
        low = min(bl.balance for bl in M.bank[mo])
        if low < 0:
            errs.append(f"bank goes negative in {mo}: {low}")
    # trial balance at 31.1. balances
    if sum(bals.values(), ZERO) != ZERO:
        errs.append("closing TB does not balance")
    if errs:
        raise CheckError("\n".join(errs))
    return True


def balances(M, upto):
    b = defaultdict(lambda: ZERO)
    for a, v in M.opening.items():
        b[a] += v
    for e in M.journal:
        if e.date <= upto:
            for l in e.lines:
                b[l.acct] += l.debit - l.credit
    return dict(b)
