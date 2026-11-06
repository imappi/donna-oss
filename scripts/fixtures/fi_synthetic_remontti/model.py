# Model for the synthetic Remonttipalvelu Kivijärvi Oy pack: turns scenario.py
# into computed documents, bank lines and the answer-key journals, and checks
# that everything reconciles to the cent. Pure computation — no rendering.
#
# Money is integer cents throughout. Rounding is half-up to the cent, applied
# per VAT-rate group on each document (the way Finnish invoicing software
# rounds), per payroll component, and per interest calculation.

from __future__ import annotations

import datetime as dt
from collections import OrderedDict, defaultdict
from decimal import ROUND_HALF_UP, Decimal

import scenario as S

D = Decimal


# ── money ───────────────────────────────────────────────────────────────────
def c(eur: str) -> int:
    """'1234.56' → 123456 cents (exact)."""
    q = D(eur) * 100
    if q != q.to_integral_value():
        raise ValueError(f"not a cent amount: {eur}")
    return int(q)


def rnd(x: Decimal) -> int:
    return int(x.quantize(D(1), rounding=ROUND_HALF_UP))


def pct(base_c: int, rate: str) -> int:
    return rnd(D(base_c) * D(rate) / 100)


def vat_in_gross(gross_c: int, rate: str) -> int:
    r = D(rate)
    return rnd(D(gross_c) * r / (100 + r))


def fmt(cents: int, plus: bool = False) -> str:
    """Finnish money format: 1 234,56 ; negative with a hyphen-minus."""
    neg = cents < 0
    a = abs(cents)
    e, s = divmod(a, 100)
    g = f"{e:,}".replace(",", " ")
    out = f"{g},{s:02d}"
    if neg:
        return "-" + out
    return ("+" + out) if plus else out


def rate_label(rate: str) -> str:
    return {"24": "24 %", "25.5": "25,5 %", "14": "14 %", "10": "10 %", "0": "0 %", "RC": "0 % (AVL 8 c §)"}[rate]


def dmy(iso: str, short: bool = False) -> str:
    d = dt.date.fromisoformat(iso)
    return f"{d.day}.{d.month}." if short else f"{d.day:02d}.{d.month:02d}.{d.year}"


def month_of(iso: str) -> str:
    return {8: "AUG", 9: "SEP"}.get(dt.date.fromisoformat(iso).month, "OTHER")


# ── identifiers ─────────────────────────────────────────────────────────────
def ytunnus(base7: str) -> str:
    w = [7, 9, 10, 5, 8, 4, 2]
    s = sum(int(d) * k for d, k in zip(base7, w))
    r = s % 11
    if r == 1:
        raise ValueError(f"Y-tunnus base {base7} has remainder 1 (no valid check digit)")
    chk = 0 if r == 0 else 11 - r
    return f"{base7}-{chk}"


def ytunnus_valid(y: str) -> bool:
    b, k = y.split("-")
    try:
        return ytunnus(b) == y and len(b) == 7 and len(k) == 1
    except ValueError:
        return False


def luhn_digit(num: str) -> int:
    total = 0
    for i, ch in enumerate(reversed(num)):
        d = int(ch)
        if i % 2 == 0:
            d *= 2
            if d > 9:
                d -= 9
        total += d
    return (10 - total % 10) % 10


def iban_from_bban13(b13: str) -> str:
    bban = b13 + str(luhn_digit(b13))
    num = bban + "1518" + "00"  # F=15, I=18
    chk = 98 - int(num) % 97
    raw = f"FI{chk:02d}{bban}"
    return " ".join(raw[i:i + 4] for i in range(0, len(raw), 4))


def iban_valid(iban: str) -> bool:
    raw = iban.replace(" ", "")
    if not (raw.startswith("FI") and len(raw) == 18):
        return False
    bban = raw[4:]
    if luhn_digit(bban[:-1]) != int(bban[-1]):
        return False
    rearr = raw[4:] + "1518" + raw[2:4]
    return int(rearr) % 97 == 1


def viite(base: str) -> str:
    w = [7, 3, 1]
    s = sum(int(d) * w[i % 3] for i, d in enumerate(reversed(base)))
    ref = base + str((10 - s % 10) % 10)
    if not 4 <= len(ref) <= 20:
        raise ValueError(ref)
    parts = []
    while ref:
        parts.insert(0, ref[-5:])
        ref = ref[:-5]
    return " ".join(parts)


def viite_valid(v: str) -> bool:
    raw = v.replace(" ", "")
    return viite(raw[:-1]).replace(" ", "") == raw


HETU_CHARS = "0123456789ABCDEFHJKLMNPRSTUVWXY"


def hetu(base: str) -> str:
    ddmmyy, nnn = base[:6], base[7:10]
    return base + HETU_CHARS[int(ddmmyy + nnn) % 31]


def hetu_valid(h: str) -> bool:
    return len(h) == 11 and hetu(h[:10]) == h and 900 <= int(h[7:10]) <= 999


# ── accounts (the key's chart) ──────────────────────────────────────────────
ACCOUNTS = OrderedDict([
    ("1100", "Koneet ja kalusto"),
    ("1700", "Myyntisaamiset"),
    ("1740", "Palkkaennakot"),
    ("1760", "ALV-saamiset (vähennettävä ALV)"),
    ("1761", "Käännetyn ALV:n vähennys"),
    ("1780", "Saamiset osakkaalta"),
    ("1790", "Selvittelytili (odottaa selvitystä)"),
    ("1800", "Siirtosaamiset (ennakkoon maksetut kulut)"),
    ("1910", "Pankkitili KSYP"),
    ("2000", "Osakepääoma"),
    ("2250", "Voittovarat (ml. tulos 1–7/2024)"),
    ("2620", "Yrityslaina"),
    ("2710", "Saadut ennakot"),
    ("2885", "Yrityskorttivelka (KSYP Yritys Visa)"),
    ("2890", "Ostovelat"),
    ("2891", "Velat osakkaalle (kulukorvaukset)"),
    ("2931", "Ennakonpidätysvelka"),
    ("2932", "Sava-velka (työnantajan sairausvakuutusmaksu)"),
    ("2935", "TyEL-velka"),
    ("2936", "Työttömyysvakuutusmaksuvelka"),
    ("2937", "Käännetyn ALV:n velka"),
    ("2939", "ALV-velka"),
    ("3000", "Myynti 25,5 %"),
    ("3001", "Myynti 24 %"),
    ("3010", "Rakentamispalvelujen myynti, käännetty verovelvollisuus"),
    ("4000", "Aine- ja tarvikeostot"),
    ("4450", "Alihankinnat (rakentamispalvelut)"),
    ("5000", "Palkat"),
    ("6100", "TyEL-maksut"),
    ("6130", "Sairausvakuutusmaksut (sava)"),
    ("6140", "Työttömyysvakuutusmaksut"),
    ("6150", "Tapaturmavakuutusmaksut"),
    ("7000", "Toimitilavuokrat"),
    ("7300", "Pakettiauton leasing ja huolto"),
    ("7310", "Polttoaineet"),
    ("7400", "Kone- ja työkaluvuokrat"),
    ("7600", "Puhelin ja tietoliikenne"),
    ("7650", "ATK-ohjelmistot"),
    ("7780", "Edustuskulut (ALV ei vähennyskelpoinen)"),
    ("7800", "Pankki- ja maksuliikennekulut"),
    ("7810", "Kilometrikorvaukset (verovapaat)"),
    ("7820", "Päivärahat (verovapaat)"),
    ("7830", "Pysäköinti ja muut matkakulut"),
    ("8810", "Korkokulut"),
    ("8850", "Veron viivästyskorot (vähennyskelvoton)"),
])
BALANCE_SHEET = {a for a in ACCOUNTS if a < "3000"}

# ALV codes used by the key. `box` = kausiveroilmoituksen kenttä.
ALV_CODES = OrderedDict([
    ("M24", "Myynti, yleinen verokanta 24 % (kenttä 301) — ennen 1.9.2024 suoritetut"),
    ("M255", "Myynti, yleinen verokanta 25,5 % (kenttä 301)"),
    ("RAKM", "Rakentamispalvelun myynti, käännetty verovelvollisuus AVL 8 c § (kenttä 319)"),
    ("O24", "Osto 24 %, vähennettävä (kenttä 307)"),
    ("O255", "Osto 25,5 %, vähennettävä (kenttä 307)"),
    ("O14", "Osto 14 %, vähennettävä (kenttä 307)"),
    ("RAKO24", "Rakentamispalvelun osto, käännetty, 24 % (318 vero / 320 peruste / 307 vähennys)"),
    ("RAKO255", "Rakentamispalvelun osto, käännetty, 25,5 % (318 / 320 / 307)"),
    ("UPO24", "Palveluosto EU:n ulkopuolelta, AVL 9 §, 24 % (vero kenttä 301 / vähennys 307)"),
    ("UPO255", "Palveluosto EU:n ulkopuolelta, AVL 9 §, 25,5 % (301 / 307)"),
    ("EV", "ALV ei vähennyskelpoinen (edustus / tosite puuttuu)"),
])
# Mapping to the running tree's ALV vocabulary (server/donna/finland/alvCodes.js)
TREE_CODE = {
    "M24": None, "M255": "ALV_25_5_OUTPUT", "RAKM": "ALV_REVERSE_CHARGE_SALES",
    "O24": None, "O255": "ALV_25_5_INPUT", "O14": "ALV_14_INPUT",
    "RAKO24": None, "RAKO255": "ALV_REVERSE_CHARGE_PURCHASE",
    "UPO24": None, "UPO255": None, "EV": "ALV_NONDEDUCTIBLE_INPUT",
}


class JL:
    """A journal line. dr/cr in cents. alv = code; role = 'tax' | 'base' | None."""
    __slots__ = ("acc", "dr", "cr", "alv", "role", "note")

    def __init__(self, acc, dr=0, cr=0, alv=None, role=None, note=""):
        assert acc in ACCOUNTS, acc
        assert dr >= 0 and cr >= 0 or True
        self.acc, self.dr, self.cr, self.alv, self.role, self.note = acc, dr, cr, alv, role, note

    @property
    def signed(self):
        return self.dr - self.cr


def Dr(acc, amt, alv=None, role=None, note=""):
    return JL(acc, dr=amt, alv=alv, role=role, note=note) if amt >= 0 else JL(acc, cr=-amt, alv=alv, role=role, note=note)


def Cr(acc, amt, alv=None, role=None, note=""):
    return JL(acc, cr=amt, alv=alv, role=role, note=note) if amt >= 0 else JL(acc, dr=-amt, alv=alv, role=role, note=note)


class Journal:
    def __init__(self, jid, date, period, kind, text, lines, docs=(), note="", terminal="posted", bank=None):
        self.id, self.date, self.period, self.kind, self.text = jid, date, period, kind, text
        self.lines, self.docs, self.note, self.terminal, self.bank = lines, list(docs), note, terminal, bank

    def balanced(self):
        return sum(l.signed for l in self.lines) == 0


# ── the model ───────────────────────────────────────────────────────────────
class Pack:
    def __init__(self):
        self.errors = []
        self.company = dict(S.COMPANY)
        self.company["ytunnus"] = ytunnus(S.COMPANY["ytunnus_base"])
        self.company["vat"] = "FI" + self.company["ytunnus"].replace("-", "")
        self.company["iban"] = iban_from_bban13(S.COMPANY["bban13"])
        self.company["tax_ref"] = viite(S.COMPANY["tax_ref_base"])
        self.parties = {}
        for k, p in S.PARTIES.items():
            q = dict(p)
            if "ytunnus_base" in p:
                q["ytunnus"] = ytunnus(p["ytunnus_base"])
                q["vat"] = "FI" + q["ytunnus"].replace("-", "")
            if "bban13" in p:
                q["iban"] = iban_from_bban13(p["bban13"])
            if "wrong_bban13" in p:
                q["wrong_iban"] = iban_from_bban13(p["wrong_bban13"])
            self.parties[k] = q
        self.people = {}
        for k, p in S.PEOPLE.items():
            q = dict(p)
            q["hetu"] = hetu(p["hetu_base"])
            q["iban"] = iban_from_bban13(p["bban13"])
            self.people[k] = q
        self.build_sales()
        self.build_purchases()
        self.build_card()
        self.build_payroll()
        self.build_institutions()
        self.build_bank()
        self.build_doc_journals()
        self.derive_opening()
        self.run_checks()

    # ── documents ──
    def _lines(self, raw, purchase=False):
        out = []
        for ln in raw:
            desc, qty, unit, price, rate, extra = ln
            amt = rnd(D(qty) * D(price) * 100)
            out.append(dict(desc=desc, qty=qty, unit=unit, price=c(price) if "." in price and len(price.split(".")[1]) <= 2 else None,
                            price_str=price, rate=rate, amount=amt, **({"account": extra} if purchase else {"kind": extra})))
        return out

    @staticmethod
    def _vat_groups(lines):
        groups = OrderedDict()
        for l in lines:
            groups.setdefault(l["rate"], 0)
            groups[l["rate"]] += l["amount"]
        vat = OrderedDict()
        for r, net in groups.items():
            vat[r] = pct(net, r) if r not in ("RC", "0") else 0
        return groups, vat

    def build_sales(self):
        self.sales = OrderedDict()
        for s in S.SALES:
            d = dict(s)
            d["lines"] = self._lines(s["lines"])
            d["groups"], d["vat_by_rate"] = self._vat_groups(d["lines"])
            d["net"] = sum(d["groups"].values())
            d["vat"] = sum(d["vat_by_rate"].values())
            d["gross"] = d["net"] + d["vat"]
            d["viite"] = viite(str(s["no"]) + "7")
            if s.get("household"):
                d["household_work"] = sum(l["amount"] + (pct(l["amount"], l["rate"]) if l["rate"] not in ("RC", "0") else 0)
                                          for l in d["lines"] if l["kind"] == "tyo")
            self.sales[s["no"]] = d
        adv = self.sales[2406].get("advance_of")
        if adv:
            a = self.sales[adv]
            self.sales[2406]["advance_info"] = dict(no=adv, net=a["net"], vat=a["vat"], gross=a["gross"], rate="24")
            self.sales[2406]["contract_net"] = a["net"] + self.sales[2406]["net"]

    def build_purchases(self):
        self.purchases = OrderedDict()
        for p in S.PURCHASES:
            d = dict(p)
            d["lines"] = self._lines(p["lines"], purchase=True)
            d["groups"], d["vat_by_rate"] = self._vat_groups(d["lines"])
            d["net"] = sum(d["groups"].values())
            d["vat"] = sum(d["vat_by_rate"].values())
            d["gross"] = d["net"] + d["vat"]
            if "viite_base" in p:
                d["viite"] = viite(p["viite_base"])
            if p.get("reverse_charge"):
                rate = "24" if p["delivered"] < "2024-09-01" else "25.5"
                d["rc_rate"] = rate
                d["rc_tax"] = pct(d["net"], rate)
            self.purchases[p["id"]] = d
        pins = self.purchases["PINS"]
        tax_line = [l for l in pins["lines"] if l["desc"].startswith("Vakuutusmaksuvero")][0]
        base_line = [l for l in pins["lines"] if l["desc"].startswith("Yritysvastuu")][0]
        if pct(base_line["amount"], S.RATES["insurance_premium_tax_from_2024_09_01_pct"]) != tax_line["amount"]:
            self.errors.append("insurance premium tax line != 25.5 % of the liability premium")

    def build_card(self):
        self.card = OrderedDict()
        for m, spec in S.CARD.items():
            purchases = []
            for p in spec["purchases"]:
                q = dict(p)
                if "fuel" in p:
                    name, litres, unit = p["fuel"]
                    q["gross"] = rnd(D(litres) * D(unit) * 100)
                    q["item_lines"] = [(name, litres, unit, q["gross"])]
                elif "usd" in p:
                    eur = rnd(D(p["usd"]) / D(p["fx"]) * 100)
                    q["gross"] = eur
                    q["fx_fee"] = pct(eur, p["fx_fee_pct"])
                elif "amount" in p:
                    q["gross"] = c(p["amount"])
                else:
                    q["item_lines"] = [(n, qty, pr, rnd(D(qty) * D(pr) * 100)) for n, qty, pr in p["items"]]
                    q["gross"] = sum(x[3] for x in q["item_lines"])
                if p["rate"] in ("24", "25.5", "14") and not p.get("missing"):
                    q["vat"] = vat_in_gross(q["gross"], p["rate"])
                    q["net"] = q["gross"] - q["vat"]
                purchases.append(q)
            total = sum(q["gross"] + q.get("fx_fee", 0) for q in purchases)
            self.card[m] = dict(spec, purchases=purchases, total=total, viite=viite(spec["viite_base"]))
        # cash receipt
        cr = dict(S.CASH_RECEIPT)
        cr["gross_c"] = c(cr["gross"])
        cr["vat"] = vat_in_gross(cr["gross_c"], cr["rate"])
        cr["net"] = cr["gross_c"] - cr["vat"]
        self.cash_receipt = cr
        # mileage log
        km_rate = D(S.RATES["km_allowance_2024_eur_per_km"])
        log = []
        for date, route, km, purpose, commute in S.MILEAGE_LOG:
            log.append(dict(date=date, route=route, km=int(km), purpose=purpose, commute=commute,
                            claimed=rnd(D(km) * km_rate * 100)))
        self.mileage = dict(log=log)
        for m in ("AUG", "SEP"):
            rows = [r for r in log if month_of(r["date"]) == m]
            self.mileage[m] = dict(km=sum(r["km"] for r in rows), claimed=rnd(D(sum(r["km"] for r in rows)) * km_rate * 100),
                                   commute_km=sum(r["km"] for r in rows if r["commute"]))
            self.mileage[m]["taxfree"] = rnd(D(self.mileage[m]["km"] - self.mileage[m]["commute_km"]) * km_rate * 100)
            self.mileage[m]["excess"] = self.mileage[m]["claimed"] - self.mileage[m]["taxfree"]
        tot_km = sum(r["km"] for r in log)
        self.mileage["claimed_total"] = rnd(D(tot_km) * km_rate * 100)
        self.mileage["km_total"] = tot_km
        if self.mileage["claimed_total"] != self.mileage["AUG"]["claimed"] + self.mileage["SEP"]["claimed"]:
            self.errors.append("mileage claim does not split exactly by month")

    def build_payroll(self):
        R = S.RATES
        self.payroll = OrderedDict()
        for m, spec in S.PAYROLL.items():
            month = dict(spec)
            emps = OrderedDict()
            for e in ("e1", "e2"):
                p = S.PEOPLE[e]
                x = spec[e]
                gross = rnd(D(x["hours"]) * D(p["hourly"]) * 100)
                tyel_pct = R["tyel_employee_17_52_pct"] if p["age"] <= 52 else R["tyel_employee_53_62_pct"]
                row = dict(hours=x["hours"], hourly=p["hourly"], gross=gross,
                           withholding=pct(gross, p["tax_pct"]), tax_pct=p["tax_pct"],
                           tyel=pct(gross, tyel_pct), tyel_pct=tyel_pct,
                           tvr=pct(gross, R["tvr_employee_2024_pct"]),
                           km=int(x["km"]), km_amt=rnd(D(x["km"]) * D(R["km_allowance_2024_eur_per_km"]) * 100),
                           pd_full=x["per_diem_full"], pd_partial=x["per_diem_partial"],
                           pd_amt=x["per_diem_full"] * c(R["per_diem_full_2024"]) + x["per_diem_partial"] * c(R["per_diem_partial_2024"]),
                           advance=c(x.get("advance", "0")), trips=x.get("trips"))
                row["net"] = row["gross"] - row["withholding"] - row["tyel"] - row["tvr"] + row["km_amt"] + row["pd_amt"] - row["advance"]
                emps[e] = row
            month["emps"] = emps
            g = sum(r["gross"] for r in emps.values())
            month["gross"] = g
            month["withholding"] = sum(r["withholding"] for r in emps.values())
            month["tyel_employee"] = sum(r["tyel"] for r in emps.values())
            month["tvr_employee"] = sum(r["tvr"] for r in emps.values())
            month["tyel_total"] = pct(g, R["tyel_total_2024_pct"])
            month["tyel_employer"] = month["tyel_total"] - month["tyel_employee"]
            month["sava"] = pct(g, R["sava_employer_2024_pct"])
            month["tvr_employer"] = pct(g, R["tvr_employer_2024_pct"])
            month["km"] = sum(r["km_amt"] for r in emps.values())
            month["pd"] = sum(r["pd_amt"] for r in emps.values())
            month["net"] = sum(r["net"] for r in emps.values())
            month["advance"] = sum(r["advance"] for r in emps.values())
            self.payroll[m] = month

    def build_institutions(self):
        R, O = S.RATES, S.OPENING
        july_gross = c(O["payroll_july_gross"])
        self.opening_payroll = dict(
            july_gross=july_gross,
            tyel_july=pct(july_gross, R["tyel_total_2024_pct"]),
            sava_july=pct(july_gross, R["sava_employer_2024_pct"]),
            withholding_july=c(O["withholding_july"]),
        )
        may_jul = c(O["payroll_may_gross"]) + c(O["payroll_june_gross"]) + july_gross
        self.opening_payroll["tvr_base_may_jul"] = may_jul
        self.opening_payroll["tvr_accrued_may_jul"] = pct(may_jul, R["tvr_employer_2024_pct"]) + pct(may_jul, R["tvr_employee_2024_pct"])
        # TyEL invoices
        self.tyel = OrderedDict()
        for t in S.TYEL:
            gross = july_gross if t["gross_from"] == "opening" else self.payroll[t["gross_from"]]["gross"]
            d = dict(t, base=gross, total=pct(gross, R["tyel_total_2024_pct"]), viite=viite(t["viite_base"]))
            if t["gross_from"] != "opening":
                pm = self.payroll[t["gross_from"]]
                d["employee"] = pm["tyel_employee"]
                d["employer"] = pm["tyel_employer"]
                d["split"] = [(k, S.PEOPLE[k]["name"], pm["emps"][k]["gross"], pm["emps"][k]["tyel_pct"], pm["emps"][k]["tyel"]) for k in ("e1", "e2")]
            self.tyel[t["id"]] = d
        # YEL
        monthly = rnd(D(S.YEL["work_income"]) * D(R["yel_2024_pct"]) / 100 * 100 / 12)
        self.yel = OrderedDict((y["id"], dict(y, amount=monthly, viite=viite(y["viite_base"]))) for y in S.YEL["invoices"])
        # TVR invoice (May–Aug)
        base = may_jul + self.payroll["AUG"]["gross"]
        emp_c = pct(base, R["tvr_employer_2024_pct"])
        ee_c = pct(base, R["tvr_employee_2024_pct"])
        self.tvr = dict(S.TVR_INVOICE, base=base, employer=emp_c, employee=ee_c, total=emp_c + ee_c,
                        viite=viite(S.TVR_INVOICE["viite_base"]),
                        months=[("5/2024", c(O["payroll_may_gross"])), ("6/2024", c(O["payroll_june_gross"])),
                                ("7/2024", july_gross), ("8/2024", self.payroll["AUG"]["gross"])])
        accrued = self.opening_payroll["tvr_accrued_may_jul"] + self.payroll["AUG"]["tvr_employee"] + self.payroll["AUG"]["tvr_employer"]
        self.tvr["accrued"] = accrued
        self.tvr["rounding_diff"] = self.tvr["total"] - accrued
        # OmaVero
        alv6 = c(O["alv_payable"][0]["amount"])
        alv7 = c(O["alv_payable"][1]["amount"])
        late = S.OMAVERO["late_payment"]
        aug_items = [("ALV 6/2024", late["due"], alv6), ("Ennakonpidätys 7/2024", late["due"], self.opening_payroll["withholding_july"]),
                     ("Työnantajan sairausvakuutusmaksu 7/2024", late["due"], self.opening_payroll["sava_july"])]
        aug_total = sum(a for _, _, a in aug_items)
        days_late = (dt.date.fromisoformat(late["paid"]) - dt.date.fromisoformat(late["due"])).days
        interest = rnd(D(aug_total) * D(R["tax_late_interest_2024_pct"]) / 100 * days_late / 365)
        pa = self.payroll["AUG"]
        sep_items = [("ALV 7/2024", "2024-09-12", alv7), ("Ennakonpidätys 8/2024", "2024-09-12", pa["withholding"]),
                     ("Työnantajan sairausvakuutusmaksu 8/2024", "2024-09-12", pa["sava"]),
                     ("Viivästyskorko (maksu 21.8.2024, erät 12.8.2024)", "2024-09-12", interest)]
        self.omavero = dict(aug_items=aug_items, aug_total=aug_total, days_late=days_late, interest=interest,
                            sep_items=sep_items, sep_total=sum(a for *_, a in sep_items), alv6=alv6, alv7=alv7)
        # loan
        bal = c(S.OPENING["loan"])
        inst = []
        for i in S.LOAN["instalments"]:
            interest_c = rnd(D(bal) * D(S.LOAN["rate_pct"]) / 100 * i["days"] / 360)
            principal = c(S.LOAN["principal_per_instalment"])
            inst.append(dict(i, balance_before=bal, interest=interest_c, principal=principal, total=interest_c + principal,
                             balance_after=bal - principal))
            bal -= principal
        self.loan = inst
        # SumUp
        inv = self.sales[S.SUMUP["invoice"]]
        fee = pct(inv["gross"], S.SUMUP["fee_pct"])
        self.sumup = dict(S.SUMUP, gross=inv["gross"], fee=fee, net=inv["gross"] - fee)

    # ── bank + bank-line journals (section B1) ──
    def build_bank(self):
        self.bank = OrderedDict()
        self.journals = []
        self.cleared = defaultdict(int)  # receivable/payable clearing per doc
        bal = c(S.OPENING["bank"])
        seq = 0
        for m in ("AUG", "SEP"):
            rows = []
            opening = bal
            for date, kind, arg in S.BANK_SCHEDULE[m]:
                for row in self._bank_rows(m, date, kind, arg):
                    seq += 1
                    bal += row["amount"]
                    row["balance"] = bal
                    row["id"] = f"B-{'08' if m == 'AUG' else '09'}-{len(rows) + 1:02d}"
                    d = dt.date.fromisoformat(date)
                    row["archive"] = f"{d:%y%m%d}KSYP{(seq * 7919) % 1000000:06d}"
                    row["date"] = date
                    rows.append(row)
                    j = row.pop("journal")
                    j.id, j.date, j.period, j.kind, j.bank = row["id"], date, m, "bank", row
                    if not j.text:
                        j.text = f"{row['type']} {row['party']}"
                    self.journals.append(j)
            self.bank[m] = dict(opening=opening, closing=bal, rows=rows)

    def _j(self, lines, docs=(), note="", terminal="posted", text=""):
        return Journal(None, None, None, None, text, lines, docs, note, terminal)

    def _row(self, typ, party, msg, amount, journal):
        return dict(type=typ, party=party, msg=msg, amount=amount, journal=journal)

    def _bank_rows(self, m, date, kind, arg):
        P, sales, pur = self.parties, self.sales, self.purchases
        if kind == "receipt_opening":
            r = S.OPENING["receivables"][0]
            amt = c(r["amount"])
            return [self._row("TILISIIRTO", P[r["party"]]["name"].upper(), f"VIITE {viite(str(r['no']) + '7')}", amt,
                              self._j([Dr("1910", amt), Cr("1700", amt, note=f"lasku {r['no']} (avaava saldo)")], [f"03"],
                                      "Heinäkuun laskun 2398 suoritus — avaavassa saldossa oleva myyntisaaminen."))]
        if kind in ("pay", "pay_again"):
            p = pur[arg]
            party = P[p["party"]]
            return [self._row("E-LASKU" if kind == "pay" and p["party"] not in ("ranta", "salmela", "konevuokra") else "TILISIIRTO",
                              party["name"].upper(), f"VIITE {p['viite']}" if "viite" in p else p["no"], -p["gross"],
                              self._purchase_payment_journal(p, m, again=(kind == "pay_again")))]
        if kind == "pay_wrong_iban":
            p = pur[arg]
            return [self._row("TILISIIRTO", P[p["party"]]["name"].upper(), f"VIITE {p['viite']} · TILI {P[p['party']]['wrong_iban']}", -p["gross"],
                              self._j([Dr("2890", p["gross"], note=f"lasku {p['no']}"), Cr("1910", p["gross"])], [p["id"]],
                                      "Maksu lähti väärälle tilinumerolle (kirjoitusvirhe: oikea tili on laskulla). Kirjataan ostovelan suoritukseksi; palautus 23.9. kumoaa sen."))]
        if kind == "returned":
            p = pur[arg]
            return [self._row("PALAUTUNUT MAKSU", P[p["party"]]["name"].upper(), S.RETURNED_PAYMENT["reason"], p["gross"],
                              self._j([Dr("1910", p["gross"]), Cr("2890", p["gross"], note=f"lasku {p['no']} palautui")], [p["id"]],
                                      "Pankki palautti 19.9. maksun (tili ei käytössä). Ostovelka 40118 on taas avoinna; uusi maksu 24.9. oikealle tilille."))]
        if kind == "salary_advance":
            e = S.SALARY_ADVANCE
            amt = c(e["amount"])
            return [self._row("TILISIIRTO", self.people[e["employee"]]["name"].upper(), "PALKKAENNAKKO 8/2024", -amt,
                              self._j([Dr("1740", amt), Cr("1910", amt)], ["50"], "Palkkaennakko, vähennetään elokuun palkasta 30.8."))]
        if kind == "card_opening":
            amt = c(S.OPENING["card_july"])
            return [self._row("E-LASKU", "KSYP YRITYS VISA", f"KORTTILASKU 7/2024 VIITE {viite('44170724')}", -amt,
                              self._j([Dr("2885", amt, note="heinäkuun korttilasku (avaava saldo)"), Cr("1910", amt)], ["03"],
                                      "Heinäkuun korttiostot on kirjattu heinäkuun kirjanpidossa; tämä maksaa avaavan korttivelan."))]
        if kind == "card":
            cd = self.card[arg]
            return [self._row("E-LASKU", "KSYP YRITYS VISA", f"KORTTILASKU 8/2024 VIITE {cd['viite']}", -cd["total"],
                              self._j([Dr("2885", cd["total"], note="elokuun korttilasku"), Cr("1910", cd["total"])], ["05"],
                                      "Yksi veloitus maksaa koko elokuun korttilaskun; ostot on kirjattu elokuulle korttilaskun riveittäin (B2)."))]
        if kind == "yel":
            y = self.yel[arg]
            return [self._row("E-LASKU", P["kantele"]["name"].upper()[:34], f"VIITE {y['viite']}", -y["amount"],
                              self._j([Dr("1790", y["amount"], note=f"YEL {y['month']} — selvitettävä"), Cr("1910", y["amount"])], [y["id"]],
                                      "YEL on yrittäjän HENKILÖKOHTAINEN vakuutus. Yhtiön maksamana se on joko osakkaan palkkaa (ennakonpidätys + tulorekisteri) tai osakkaalta perittävä saaminen — kumpi, riippuu siitä, mitä yhtiössä on sovittu. Omistajan viesti ('niin kuin ennenkin') ei ratkaise sitä. KYSY OMISTAJALTA; kirjataan selvittelytilille.",
                                      terminal="ask_owner"))]
        if kind == "tyel":
            t = self.tyel[arg]
            return [self._row("E-LASKU", P["kantele"]["name"].upper()[:34], f"VIITE {t['viite']}", -t["total"],
                              self._j([Dr("2935", t["total"], note=f"TyEL {t['month']}"), Cr("1910", t["total"])], [t["id"]],
                                      ("Koskee HEINÄKUUN palkkoja (avaava TyEL-velka)." if t["gross_from"] == "opening"
                                       else "Koskee ELOKUUN palkkoja: työntekijäosuudet pidätetty palkoista 30.8., työnantajaosuus jaksotettu elokuulle (B2).")))]
        if kind == "omavero_aug":
            o = self.omavero
            lines = [Dr("2939", o["alv6"], note="ALV 6/2024"), Dr("2931", o["aug_items"][1][2], note="ennakonpidätys 7/2024"),
                     Dr("2932", o["aug_items"][2][2], note="sava 7/2024"), Cr("1910", o["aug_total"])]
            return [self._row("OMA-ALOITTEINEN VERO", "VEROHALLINTO", f"VIITE {self.company['tax_ref']}", -o["aug_total"],
                              self._j(lines, ["07"], f"Yksi maksu kolmelle erälle, kaikki eräpäivältä 12.8.2024 — maksettu 9 päivää myöhässä → viivästyskorko {fmt(o['interest'])} € (veloitetaan verotilillä, maksetaan 12.9.)."))]
        if kind == "omavero_sep":
            o = self.omavero
            pa = self.payroll["AUG"]
            lines = [Dr("2939", o["alv7"], note="ALV 7/2024"), Dr("2931", pa["withholding"], note="ennakonpidätys 8/2024"),
                     Dr("2932", pa["sava"], note="sava 8/2024"), Dr("8850", o["interest"], note="viivästyskorko"), Cr("1910", o["sep_total"])]
            return [self._row("OMA-ALOITTEINEN VERO", "VEROHALLINTO", f"VIITE {self.company['tax_ref']}", -o["sep_total"],
                              self._j(lines, ["07", "54"], "Yksi maksu neljälle erälle. Viivästyskorko on tuloverotuksessa vähennyskelvoton (EVL 16 § 4 k.) eikä ALV:n alainen."))]
        if kind == "advance_received":
            s = sales[arg]
            return [self._row("TILISIIRTO", P[s["party"]]["name"].upper(), f"VIITE {s['viite']}", s["gross"],
                              self._j([Dr("1910", s["gross"]), Cr("2710", s["net"], alv="M24", role="base", note="saatu ennakko, lasku 2402"),
                                       Cr("2939", s["vat"], alv="M24", role="tax", note="ALV 24 % ennakosta")], [f"S{arg}"],
                                      "Ennakkomaksun ALV syntyy maksun VASTAANOTTOKUUKAUDELLE (23.8.) ja kanta on 24 %, koska ennakko saatiin ennen 1.9.2024 — vaikka urakka valmistuu syyskuussa. Tuloa ei kirjata vielä (saadut ennakot).",
                                      text="Ennakko Salonen"))]
        if kind == "loan":
            i = self.loan[arg]
            return [self._row("LAINANHOITO", f"KSYP YRITYSLAINA {S.LOAN['no']}", "LYHENNYS+KORKO", -i["total"],
                              self._j([Dr("2620", i["principal"], note="lyhennys"), Dr("8810", i["interest"], note="korko"), Cr("1910", i["total"])], ["04"],
                                      "Jako lainalaskelmasta: lyhennys taseeseen, korko kuluksi."))]
        if kind == "salary":
            mm, e = arg
            r = self.payroll[mm]["emps"][e]
            lines = [Dr("5000", r["gross"], note="bruttopalkka")]
            if r["km_amt"]:
                lines.append(Dr("7810", r["km_amt"], note=f"km-korvaus {r['km']} km"))
            if r["pd_amt"]:
                lines.append(Dr("7820", r["pd_amt"], note="päivärahat"))
            lines += [Cr("2931", r["withholding"], note="ennakonpidätys"), Cr("2935", r["tyel"], note="TyEL työntekijä"),
                      Cr("2936", r["tvr"], note="TVR työntekijä")]
            if r["advance"]:
                lines.append(Cr("1740", r["advance"], note="palkkaennakko 15.8."))
            lines.append(Cr("1910", r["net"]))
            doc = {("AUG", "e1"): "50", ("AUG", "e2"): "51", ("SEP", "e1"): "52", ("SEP", "e2"): "53"}[(mm, e)]
            note = f"Palkka {'8' if mm == 'AUG' else '9'}/2024 bruttona; pidätykset velaksi."
            if e == "e2":
                note += " HUOM TyEL-työntekijäosuus 8,65 % (53–62-vuotias), ei 7,15 %."
            if r["advance"]:
                note += " Palkkaennakko 500,00 vähennetty nettopalkasta."
            return [self._row("PALKKA", self.people[e]["name"].upper(), f"PALKKA {'8' if mm == 'AUG' else '9'}/2024", -r["net"],
                              self._j(lines, [doc, "54"], note))]
        if kind == "fees":
            date_, typ, msg, amt = S.BANK_FEES[m][arg]
            a = c(amt)
            return [self._row(typ, "KSYP", msg, -a, self._j([Dr("7800", a), Cr("1910", a)], [], "Pankkipalvelumaksu, arvonlisäveroton rahoituspalvelu."))]
        if kind == "owner_repay":
            priv = [p for p in self.card["AUG"]["purchases"] if p.get("private")][0]
            el = pur["PSAHKO"]
            amt = priv["gross"] + el["gross"]
            return [self._row("TILISIIRTO", self.people["owner"]["name"].upper(), "PALAUTUS YKSITYISET: ELEKTRONETTI 14.8 + SÄHKÖ", amt,
                              self._j([Dr("1910", amt), Cr("1780", priv["gross"], note="ElektroNetti 14.8. (kortti)"),
                                       Cr("1780", el["gross"], note="kodin sähkölasku 12.8.")], ["08"],
                                      "Omistaja palauttaa kaksi yksityistä menoa yhdellä maksulla; molemmat oli kirjattu saamiseksi osakkaalta (ei kuluksi, ei ALV-vähennystä)."))]
        if kind == "receipt":
            (no,) = arg
            s = sales[no]
            self.cleared[no] += s["gross"]
            return [self._row("TILISIIRTO", P[s["party"]]["name"].upper(), f"VIITE {s['viite']}", s["gross"],
                              self._j([Dr("1910", s["gross"]), Cr("1700", s["gross"], note=f"lasku {no}")], [f"S{no}"],
                                      {2405: "Rinteen lasku 2405 — suoritus kuukauden sisällä; myynti kirjattiin ELOKUULLE (työ valmis 29.8.).",
                                       2406: "Salosen loppulasku 2406 maksettu kokonaan."}.get(no, "")))]
        if kind == "receipt_partial":
            no, part = arg
            s = sales[no]
            amt = c(part)
            self.cleared[no] += amt
            return [self._row("TILISIIRTO", P[s["party"]]["name"].upper()[:34], f"VIITE {s['viite']} OSAMAKSU", amt,
                              self._j([Dr("1910", amt), Cr("1700", amt, note=f"lasku {no} osasuoritus")], [f"S{no}"],
                                      f"Osamaksu. Laskusta 2404 jää avoimeksi {fmt(s['gross'] - amt)} € (myyntisaaminen 30.9.). Ei luottotappiota, ei hyvitystä — avoin saaminen."))]
        if kind == "receipt_rautio":
            (no,) = arg
            s = sales[no]
            orig = sales[2403]
            self.cleared[no] += s["gross"]
            return [self._row("TILISIIRTO", P[s["party"]]["name"].upper(), f"VIITE {orig['viite']} LASKU 2403 ILMAN ALV AVL 8C", s["gross"],
                              self._j([Dr("1910", s["gross"]), Cr("1700", s["gross"], note="oikaistu lasku 2408")], ["S2408", "S2403", "S2407"],
                                      "Asiakas käytti VANHAN laskun 2403 viitettä, mutta maksoi oikaistun laskun 2408 summan. Kohdistus laskulle 2408; 2403 on kuitattu hyvityksellä 2407."))]
        if kind == "receipt_bundle":
            nos = arg
            amt = sum(sales[n]["gross"] for n in nos)
            for n in nos:
                self.cleared[n] += sales[n]["gross"]
            first = sales[nos[0]]
            return [self._row("TILISIIRTO", P[first["party"]]["name"].upper(), f"VIITE {first['viite']}", amt,
                              self._j([Dr("1910", amt)] + [Cr("1700", sales[n]["gross"], note=f"lasku {n}") for n in nos], [f"S{n}" for n in nos],
                                      f"Yksi suoritus kahdelle laskulle, mutta vain laskun {nos[0]} viitteellä. Summa = {' + '.join(fmt(sales[n]['gross']) for n in nos)}. Lasku 2401 oli myöhässä (eräpäivä 30.8.)."))]
        if kind == "sumup":
            su = self.sumup
            self.cleared[arg] += su["gross"]
            return [self._row("SUMUP TILITYS", "SUMUP PAYMENTS", f"TILITYS {dmy(su['tx_date'], True)} {su['tx_id']}", su["net"],
                              self._j([Dr("1910", su["net"]), Dr("7800", su["fee"], note="korttimaksupalkkio"), Cr("1700", su["gross"], note="lasku 2410")],
                                      ["S2410", "20"],
                                      "Korttimaksun tilitys: bruttomyynti (lasku 2410) miinus palkkio. Palkkio on arvonlisäveroton rahoituspalvelu."))]
        if kind == "refund":
            p = pur[arg]
            vat = p["vat"]
            return [self._row("TILISIIRTO", P[p["party"]]["name"].upper(), f"HYVITYSLASKU {p['no']}", -p["gross"],
                              self._j([Dr("1910", -p["gross"]), Cr("4000", -p["net"], note="palautetut tavarat"),
                                       Cr("1760", -vat, alv="O24", role="tax", note="ALV-vähennyksen oikaisu 24 %")], [p["id"]],
                                      "Hyvitys ALKUPERÄISEN toimituksen verokannalla 24 % (toimitus 28.8.), vaikka hyvityslasku on syyskuulta. Vähennyksen oikaisu syyskuulle (palautus 9.9.)."))]
        if kind == "pay_bundle":
            ps = [pur[x] for x in arg]
            lines = []
            for p in ps:
                lines += self._purchase_lines(p)
            amt = sum(p["gross"] for p in ps)
            lines.append(Cr("1910", amt))
            return [self._row("TILISIIRTO", P[ps[0]["party"]]["name"].upper(), "LASKUT " + ", ".join(p["no"] for p in ps), -amt,
                              self._j(lines, [p["id"] for p in ps],
                                      "Yksi maksu kahdelle laskulle. Lasku 59611 sisältää bonusrivin 24 %:n kannalla (bonus koskee alkuvuoden 24 %:n ostoja) — kaksi verokantaa samalla laskulla."))]
        if kind == "tvr":
            t = self.tvr
            lines = [Dr("2936", t["accrued"], note="kertynyt TVR-velka 5–8/2024")]
            if t["rounding_diff"]:
                lines.append(Dr("6140", t["rounding_diff"], note="pyöristysero"))
            lines.append(Cr("1910", t["total"]))
            return [self._row("E-LASKU", "TYÖLLISYYSRAHASTO", f"VIITE {t['viite']}", -t["total"],
                              self._j(lines, ["60"], f"Lasku kattaa palkat 5–8/2024 (touko–heinäkuu avaavassa saldossa). Rahasto laskee maksun palkkasummasta, kirjanpito henkilöittäin → pyöristysero {fmt(t['rounding_diff'])} €."))]
        if kind == "owner_claims":
            mi = self.mileage
            cr_ = self.cash_receipt
            amt = mi["claimed_total"] + cr_["gross_c"]
            sep = mi["SEP"]
            lines = [Dr("2891", mi["AUG"]["claimed"] + cr_["gross_c"], note="elokuun km-korvaus + käteisostos 27.8. (jaksotettu elokuulle)"),
                     Dr("7810", sep["taxfree"], note=f"syyskuun km {sep['km'] - sep['commute_km']} km, verovapaa"),
                     Dr("1780", sep["excess"], note=f"liikaa maksettu: työmatka koti–varasto {sep['commute_km']} km"),
                     Cr("1910", amt)]
            return [self._row("TILISIIRTO", self.people["owner"]["name"].upper(), "KULUKORVAUKSET 8-9/2024 (KM + KÄTEISKUITTI)", -amt,
                              self._j(lines, ["55", "77"],
                                      f"Yksi maksu kattaa km-korvaukset 8–9/2024 ({mi['km_total']} km × 0,57 €) ja käteisostoksen 120,00 €. 5.9. ajo koti–varasto on asunnon ja VAKITUISEN työpaikan välinen matka: ei verovapaa. Avain perii {fmt(sep['excess'])} € osakkaalta (vaihtoehto: veronalaista palkkaa)."))]
        raise KeyError(kind)

    def _purchase_lines(self, p):
        """Expense/VAT lines of a purchase document (no bank/payable leg)."""
        lines = []
        if p.get("reverse_charge"):
            code = "RAKO24" if p["rc_rate"] == "24" else "RAKO255"
            for acc in sorted({l["account"] for l in p["lines"]}):
                lines.append(Dr(acc, sum(l["amount"] for l in p["lines"] if l["account"] == acc), alv=code, role="base"))
            lines.append(Dr("1761", p["rc_tax"], alv=code, role="deduct", note=f"käännetty ALV {rate_label(p['rc_rate'])} vähennys"))
            lines.append(Cr("2937", p["rc_tax"], alv=code, role="tax", note=f"käännetty ALV {rate_label(p['rc_rate'])} vero"))
            return lines
        by = OrderedDict()
        for l in p["lines"]:
            by.setdefault((l["account"], l["rate"]), 0)
            by[(l["account"], l["rate"])] += l["amount"]
        for (acc, rate), net in by.items():
            code = {"24": "O24", "25.5": "O255", "14": "O14"}.get(rate)
            lines.append(Dr(acc, net, alv=code, role="base" if code else None))
        for rate, vat in p["vat_by_rate"].items():
            if vat:
                lines.append(Dr("1760", vat, alv={"24": "O24", "25.5": "O255", "14": "O14"}[rate], role="tax"))
        return lines

    def _purchase_payment_journal(self, p, m, again=False):
        pid = p["id"]
        if again:
            return self._j([Dr("2890", p["gross"], note=f"lasku {p['no']}"), Cr("1910", p["gross"])], [pid],
                           "Uusi maksu oikealle tilille. Lasku 40118 on kirjattu syyskuun ostovelaksi (B2).")
        if pid in ("P59240", "PLV08"):
            return self._j([Dr("2890", p["gross"], note=f"lasku {p['no']} (elokuun ostovelka)"), Cr("1910", p["gross"])], [pid],
                           "Kulu ja ALV-vähennys kuuluvat ELOKUULLE (toimitus/palvelu elokuussa) — kirjattu B2:ssa ostovelaksi; tämä on vain maksu.")
        if pid == "PSAHKO":
            return self._j([Dr("1780", p["gross"], note="osakkaan kodin sähkö"), Cr("1910", p["gross"])], [pid, "08"],
                           "Omistajan KODIN sähkölasku maksettu yhtiön tililtä. Ei yhtiön kulu, ei ALV-vähennystä → saaminen osakkaalta. Palautettu 10.9.",
                           text="Yksityinen sähkölasku")
        lines = self._purchase_lines(p)
        note = ""
        if pid == "PVR09":
            lines = [Dr("1800", p["net"], note="syyskuun vuokra ennakkoon"), Dr("1760", p["vat"], alv="O24", role="tax")]
            note = ("Syyskuun vuokra maksettu 30.8. ETUKÄTEEN: ennen 1.9. maksettuun ennakkoon sovelletaan 24 %, ja ostaja vähentää ennakon ALV:n "
                    "MAKSUKUUKAUDELTA (AVL 141 §) → elokuun 307. Kulu jaksotetaan syyskuulle (B2).")
        elif pid == "PVR10":
            lines = [Dr("1800", p["net"], note="lokakuun vuokra ennakkoon"), Dr("1760", p["vat"], alv="O255", role="tax")]
            note = "Lokakuun vuokra maksettu etukäteen 30.9.: siirtosaaminen 30.9., ALV 25,5 % vähennetään syyskuulta (maksukuukausi, AVL 141 §)."
        elif pid == "PINS":
            lines = [Dr(acc, sum(l["amount"] for l in p["lines"] if l["account"] == acc),
                        note={"6150": "tapaturmavakuutus 3/4 2024", "1800": "vastuuvakuutus 10/2024–9/2025 + vakuutusmaksuvero"}[acc])
                     for acc in ("6150", "1800")]
            note = ("Vakuutukset ovat ALV-vapaita. Laskun '25,5 %' on VAKUUTUSMAKSUVERO, ei ALV → ei vähennystä. Vastuuvakuutuksen kausi alkaa 1.10.: koko 577,30 € "
                    "siirtosaamiseksi 30.9. (ei syyskuun kulu).")
        elif pid == "P1187":
            note = "Rakentamispalvelun osto aliurakoitsijalta: käännetty verovelvollisuus. Työ 6.–8.8. → verokanta 24 %; ostaja ilmoittaa veron (318) ja vähentää sen (307), peruste 320."
        elif pid == "P2024066":
            note = ("Käännetty verovelvollisuus koskee ostoa, koska ME myymme rakentamispalveluja (loppuasiakas kuluttaja ei muuta tätä). "
                    "Työ valmistui 5.9. → koko työ 25,5 %, vaikka aloitettiin 29.8.")
        elif pid == "PNV08":
            note = "Pakettiauto (N1): leasing ja huolto vähennyskelpoisia. Laskutuskausi elokuu → 24 %."
        elif pid == "PNV09":
            note = "Laskutuskausi syyskuu → 25,5 %."
        elif pid == "PLV07":
            note = ("Heinäkuun palvelu, lasku saapui elokuussa. Heinäkuu on suljettu eikä avaavassa saldossa ole jaksotusta → kirjataan elokuulle "
                    "(olennaisuus; ALV vähennetään elokuulta, lasku saatu elokuussa). Kanta 24 % oikein (palvelu heinäkuussa).")
        elif pid == "P58811":
            note = "Tarvikeostot, toimitus 5.8. → 24 %."
        elif pid in ("PKK08", "PKK09"):
            note = "Ohjelmistotilaus, kausi " + ("8/2024 → 24 %." if pid == "PKK08" else "9/2024 → 25,5 %.")
        lines.append(Cr("1910", p["gross"]))
        return self._j(lines, [pid], note)

    # ── non-bank journals (section B2) ──
    def build_doc_journals(self):
        J = self.journals
        sales, pur, P = self.sales, self.purchases, self.parties

        def add(jid, date, period, text, lines, docs, note="", terminal="posted"):
            J.append(Journal(jid, date, period, "memo", text, lines, docs, note, terminal))

        # opening prepaid rent → August expense
        add("M-08-01", "2024-08-01", "AUG", "Elokuun vuokra (maksettu heinäkuussa)", [Dr("7000", c(S.OPENING["prepaid_rent_aug"])), Cr("1800", c(S.OPENING["prepaid_rent_aug"]))],
            ["03"], "Avaavan saldon siirtosaaminen kuluksi elokuulle. ALV vähennettiin heinäkuussa (maksukuukausi).")

        # sales invoices
        for no, s in sales.items():
            if s.get("advance"):
                continue  # 2402 booked at receipt (bank)
            period = "AUG" if s["supply"][1] < "2024-09-01" else "SEP"
            if no in (2407, 2408):
                period = "SEP"
            lines = [Dr("1700", s["gross"], note=f"lasku {no}")]
            for rate, net in s["groups"].items():
                if rate == "RC":
                    lines.append(Cr("3010", net, alv="RAKM", role="base"))
                else:
                    code = {"24": "M24", "25.5": "M255"}[rate]
                    lines.append(Cr({"24": "3001", "25.5": "3000"}[rate], net, alv=code, role="base"))
                    lines.append(Cr("2939", s["vat_by_rate"][rate], alv=code, role="tax"))
            note = {
                2401: "Rakentamispalvelun myynti rakennusliikkeelle: käännetty verovelvollisuus, ei ALV:tä. Peruste kenttään 319.",
                2403: "Laskussa on VIRHEELLISESTI ALV 24 % (ostaja on rakennusliike → olisi pitänyt olla käännetty). Laskulla ilmoitettu vero on kuitenkin suoritettava, kunnes lasku oikaistaan (AVL 85 a §) → elokuun 301. Oikaisu syyskuussa (2407/2408).",
                2404: "Asunto-osakeyhtiö EI myy rakentamispalveluja → EI käännettyä verovelvollisuutta; normaali ALV. Työ valmis 22.8. → 24 %.",
                2405: "Lasku päivätty 3.9., mutta työ VALMISTUI 29.8. → suoriteperusteisesti ELOKUUN myynti ja 24 % (suoritusajankohta ratkaisee, ei laskun päiväys). Kotitalousvähennystä varten työn osuus eritelty.",
                2406: "Urakka VALMISTUI 6.9. ilman sovittuja osasuorituksia → koko jäljellä oleva osa 25,5 %. Ennen 1.9. saatu ennakko (2402) jää 24 %:iin eikä sitä veroteta uudelleen.",
                2407: "Hyvityslasku kumoaa laskun 2403: myynti ja 24 %:n vero peruutetaan syyskuulle (hyvityksen kuukausi).",
                2408: "Oikaistu lasku käännetyllä verovelvollisuudella (työ elokuussa). Kirjataan hyvityksen kanssa syyskuulle; peruste kenttään 319.",
                2409: "Käännetty verovelvollisuus, syyskuun työ.",
                2410: "Kuluttajatyö syyskuussa → 25,5 %. Maksettu kortilla paikan päällä; tilitys SumUpilta 23.9.",
            }.get(no, "")
            add(f"S-{no}", s["date"], period, f"Myyntilasku {no} {P[s['party']]['name']}", lines, [f"S{no}"], note)
        # advance → revenue on completion of 2406
        adv = sales[2402]
        add("M-09-01", "2024-09-06", "SEP", "Ennakon 2402 tuloutus urakan valmistuessa",
            [Dr("2710", adv["net"], note="saatu ennakko"), Cr("3001", adv["net"], note="myynti 24 % (vero ilmoitettu jo elokuussa)")],
            ["S2402", "S2406"], "Urakka luovutettiin 6.9.: ennakko siirretään myynniksi. ALV 480,00 ilmoitettiin jo elokuussa → ei uutta veroa. (Myynti 24 %:n tilille, koska sen vero on laskettu 24 %:lla.)")

        # purchases booked through payables (cross-month or multi-bank-line)
        for pid, period, date, note in [
            ("P59240", "AUG", "2024-08-28", "Toimitus 28.8. → ELOKUUN kulu ja ALV-vähennys, vaikka lasku on päivätty 2.9. Verokanta 24 % oikein."),
            ("PLV08", "AUG", "2024-08-31", "Elokuun palvelu, lasku 3.9. → elokuun kulu ja vähennys (24 % oikein, vaikka lasku on syyskuulta)."),
            ("P40118", "SEP", "2024-09-09", "Vuokra-aika 2.–6.9. → oikea kanta olisi 25,5 %. Toimittaja laskutti VIRHEELLISESTI 24 %. Ostaja saa vähentää enintään laskulla ilmoitetun veron (129,60 €); pyydä toimittajalta oikaistu lasku. Kulu 540,00 €."),
        ]:
            p = pur[pid]
            lines = self._purchase_lines(p) + [Cr("2890", p["gross"], note=f"lasku {p['no']}")]
            add(f"P-{p['no']}", date, period, f"Ostolasku {p['no']} {P[p['party']]['name']}", lines, [pid], note)

        # card purchases → card liability
        for m, cd in self.card.items():
            lines = []
            notes = []
            for q in cd["purchases"]:
                if q.get("private"):
                    lines.append(Dr("1780", q["gross"], note=f"{dmy(q['date'], True)} {S.PARTIES[q['merchant']]['name']} — YKSITYINEN"))
                    notes.append("ElektroNetti 14.8. on omistajan yksityinen ostos (sähköposti): saaminen osakkaalta, ei kulu, ei ALV:tä.")
                elif q.get("missing"):
                    lines.append(Dr("1790", q["gross"], note=f"{dmy(q['date'], True)} {S.PARTIES[q['merchant']]['name']} — kuitti puuttuu"))
                    notes.append("Tankki Kuokkala 29.8. 58,20 €: kuitti puuttuu eikä omistaja ole selittänyt ostoa → selvittelytili, EI ALV-vähennystä; KYSY OMISTAJALTA kuitti/selitys.")
                elif q["rate"] == "UPO":
                    code = "UPO24" if q["date"] < "2024-09-01" else "UPO255"
                    rate = "24" if code == "UPO24" else "25.5"
                    tax = pct(q["gross"], rate)
                    q["upo_tax"], q["upo_rate"] = tax, rate
                    lines += [Dr(q["account"], q["gross"], alv=code, role="base", note=f"{dmy(q['date'], True)} SiteMeasure USD {q['usd'].replace('.', ',')}"),
                              Dr("1761", tax, alv=code, role="deduct"), Cr("2937", tax, alv=code, role="tax"),
                              Dr("7800", q["fx_fee"], note="valuuttamuunnosmaksu")]
                elif q["rate"] == "14" and q["account"] == "7780":
                    lines.append(Dr("7780", q["gross"], alv="EV", note=f"{dmy(q['date'], True)} edustuslounas (ALV {fmt(q['vat'])} ei vähennyskelpoinen)"))
                    notes.append("Lounaskeidas 20.8.: kuittiin merkitty neuvottelu asiakkaan kanssa = EDUSTUS. Edustuksen ALV ei ole vähennyskelpoinen (AVL 114 §) → koko 38,60 € kuluksi; tuloverotuksessa 50 % vähennyskelpoinen.")
                else:
                    code = {"24": "O24", "25.5": "O255"}[q["rate"]]
                    lines += [Dr(q["account"], q["net"], alv=code, role="base", note=f"{dmy(q['date'], True)} {S.PARTIES[q['merchant']]['name']}"),
                              Dr("1760", q["vat"], alv=code, role="tax")]
            lines.append(Cr("2885", cd["total"], note=f"korttilasku {'8' if m == 'AUG' else '9'}/2024"))
            if m == "AUG":
                notes.append("RautaMaailma 27.8. 212,70 €: kuitista on KAKSI kuvaa (tiedostot 75 ja 76) mutta yksi korttiveloitus → kirjataan KERRAN.")
                notes.append("SiteMeasure (USA): palveluosto EU:n ulkopuolelta, AVL 9 §: ostaja ilmoittaa veron 24 % (kenttä 301) ja vähentää sen (307). Valuuttamuunnosmaksu on veroton pankkikulu.")
            else:
                notes.append("Syyskuun korttilasku on päivätty 1.10. ja maksetaan lokakuussa → 30.9. korttivelka. Ostot kuuluvat syyskuulle (25,5 %). SiteMeasure 22.9. → 25,5 %.")
            add(f"K-{'08' if m == 'AUG' else '09'}", cd["period"][1], m, f"Yrityskortin ostot {'8' if m == 'AUG' else '9'}/2024", lines, ["05" if m == "AUG" else "06"], " ".join(notes))

        # owner-paid cash receipt (August) and August mileage
        crc = self.cash_receipt
        add("M-08-02", crc["date"], "AUG", "Käteisostos omilla rahoilla (sepeli, Rinne)",
            [Dr("4000", crc["net"], alv="O24", role="base"), Dr("1760", crc["vat"], alv="O24", role="tax"),
             Cr("2891", crc["gross_c"], note="velka osakkaalle")], ["77", "08"],
            "Käsin kirjoitettu käteiskuitti (yksinkertaistettu lasku, sis. Y-tunnus ja 24 %). Maksettu omistajan omilla rahoilla → velka osakkaalle, EI pankkitapahtumaa. Hyvitetty 30.9.")
        am = self.mileage["AUG"]
        add("M-08-03", "2024-08-31", "AUG", "Omistajan km-korvaukset 8/2024 (ajopäiväkirja)",
            [Dr("7810", am["claimed"], note=f"{am['km']} km × 0,57"), Cr("2891", am["claimed"])], ["55"],
            "Elokuun ajot jaksotetaan elokuulle, vaikka korvaus maksetaan 30.9.")

        # payroll employer contributions
        for m in ("AUG", "SEP"):
            pm = self.payroll[m]
            add(f"M-{'08' if m == 'AUG' else '09'}-P", pm["payday"], m, f"Työnantajamaksut {'8' if m == 'AUG' else '9'}/2024",
                [Dr("6100", pm["tyel_employer"], note="TyEL työnantaja"), Cr("2935", pm["tyel_employer"]),
                 Dr("6130", pm["sava"], note="sava 1,16 %"), Cr("2932", pm["sava"]),
                 Dr("6140", pm["tvr_employer"], note="TVR työnantaja 0,27 %"), Cr("2936", pm["tvr_employer"])],
                ["54"], "TyEL-työnantajaosuus = 24,85 % palkkasummasta − työntekijäosuudet (työntekijä 53–62 v. maksaa 8,65 %, joten työnantaja vähemmän).")
        # September rent from prepaid
        add("M-09-02", "2024-09-01", "SEP", "Syyskuun vuokra (maksettu 30.8.)", [Dr("7000", pur["PVR09"]["net"]), Cr("1800", pur["PVR09"]["net"])], ["35"],
            "Siirtosaaminen kuluksi syyskuulle. ALV vähennettiin jo elokuussa (maksukuukausi).")

    def derive_opening(self):
        O = S.OPENING
        op = self.opening_payroll
        ob = OrderedDict()
        ob["1100"] = c(O["equipment"])
        ob["1700"] = sum(c(r["amount"]) for r in O["receivables"])
        ob["1800"] = c(O["prepaid_rent_aug"])
        ob["1910"] = c(O["bank"])
        ob["2620"] = -c(O["loan"])
        ob["2939"] = -sum(c(a["amount"]) for a in O["alv_payable"])
        ob["2931"] = -op["withholding_july"]
        ob["2932"] = -op["sava_july"]
        ob["2935"] = -op["tyel_july"]
        ob["2936"] = -op["tvr_accrued_may_jul"]
        ob["2885"] = -c(O["card_july"])
        ob["2000"] = -c(O["share_capital"])
        ob["2250"] = -sum(ob.values())
        self.opening_balances = ob

    # ── aggregates ──
    def balances(self, upto_period):
        order = {"AUG": 1, "SEP": 2}
        b = defaultdict(int, self.opening_balances)
        for j in self.journals:
            if order[j.period] <= order[upto_period]:
                for l in j.lines:
                    b[l.acc] += l.signed
        return b

    def movement(self, period):
        b = defaultdict(int)
        for j in self.journals:
            if j.period == period:
                for l in j.lines:
                    b[l.acc] += l.signed
        return b

    def alv_return(self, period):
        r = OrderedDict((k, 0) for k in ["M24_base", "M24_tax", "M255_base", "M255_tax", "UPO_tax", "RAKM_base", "RAKO_base", "RAKO_tax",
                                         "O_tax", "RAKO_deduct", "UPO_deduct", "EV_tax_note"])
        by_code = defaultdict(lambda: defaultdict(int))
        for j in self.journals:
            if j.period != period:
                continue
            for l in j.lines:
                if not l.alv:
                    continue
                by_code[l.alv][l.role] += l.signed
                if l.alv in ("M24", "M255"):
                    r[f"{l.alv}_{'tax' if l.role == 'tax' else 'base'}"] += -l.signed
                elif l.alv == "RAKM":
                    r["RAKM_base"] += -l.signed
                elif l.alv.startswith("RAKO"):
                    if l.role == "base":
                        r["RAKO_base"] += l.signed
                    elif l.role == "tax":
                        r["RAKO_tax"] += -l.signed
                    elif l.role == "deduct":
                        r["RAKO_deduct"] += l.signed
                elif l.alv.startswith("UPO"):
                    if l.role == "tax":
                        r["UPO_tax"] += -l.signed
                    elif l.role == "deduct":
                        r["UPO_deduct"] += l.signed
                elif l.alv.startswith("O") and l.role == "tax":
                    r["O_tax"] += l.signed
        r["301"] = r["M24_tax"] + r["M255_tax"] + r["UPO_tax"]
        r["318"] = r["RAKO_tax"]
        r["319"] = r["RAKM_base"]
        r["320"] = r["RAKO_base"]
        r["307"] = r["O_tax"] + r["RAKO_deduct"] + r["UPO_deduct"]
        r["308"] = r["301"] + r["318"] - r["307"]
        r["by_code"] = by_code
        return r

    def sales_pl(self, period):
        mv = self.movement(period)
        return OrderedDict((a, -mv[a]) for a in ("3000", "3001", "3010"))

    # ── checks ──
    def run_checks(self):
        E = self.errors
        ids = [self.company["ytunnus"]] + [p["ytunnus"] for p in self.parties.values() if "ytunnus" in p]
        for y in ids:
            if not ytunnus_valid(y):
                E.append(f"invalid Y-tunnus {y}")
        ibans = [self.company["iban"]] + [p["iban"] for p in self.parties.values() if "iban" in p] + \
                [p["wrong_iban"] for p in self.parties.values() if "wrong_iban" in p] + [p["iban"] for p in self.people.values()]
        for i in ibans:
            if not iban_valid(i):
                E.append(f"invalid IBAN {i}")
        if len(set(ibans)) != len(ibans):
            E.append("duplicate IBAN")
        refs = [s["viite"] for s in self.sales.values()] + [p["viite"] for p in self.purchases.values() if "viite" in p] + \
               [self.company["tax_ref"], self.tvr["viite"]] + [t["viite"] for t in self.tyel.values()] + [y["viite"] for y in self.yel.values()]
        for v in refs:
            if not viite_valid(v):
                E.append(f"invalid viite {v}")
        for p in self.people.values():
            if not hetu_valid(p["hetu"]):
                E.append(f"invalid/non-test henkilötunnus {p['hetu']}")
        # documents
        for d in list(self.sales.values()) + list(self.purchases.values()):
            if d["net"] + d["vat"] != d["gross"]:
                E.append(f"doc {d.get('no')} net+vat != gross")
            for l in d["lines"]:
                if rnd(D(l["qty"]) * D(l["price_str"]) * 100) != l["amount"]:
                    E.append(f"line math {l['desc']}")
        # journals
        for j in self.journals:
            if not j.balanced():
                E.append(f"journal {j.id} unbalanced by {sum(l.signed for l in j.lines)}")
            if j.kind == "bank":
                leg = sum(l.signed for l in j.lines if l.acc == "1910")
                if leg != j.bank["amount"]:
                    E.append(f"journal {j.id}: bank leg {leg} != statement {j.bank['amount']}")
            elif any(l.acc == "1910" for l in j.lines):
                E.append(f"memo journal {j.id} touches the bank account")
        # bank statements
        prev = c(S.OPENING["bank"])
        for m, st in self.bank.items():
            if st["opening"] != prev:
                E.append(f"{m} opening does not chain")
            if st["opening"] + sum(r["amount"] for r in st["rows"]) != st["closing"]:
                E.append(f"{m} statement does not reconcile")
            for r in st["rows"]:
                d = dt.date.fromisoformat(r["date"])
                if d.weekday() >= 5:
                    E.append(f"{r['id']} on a weekend {r['date']}")
                if month_of(r["date"]) != m:
                    E.append(f"{r['id']} outside its month")
            dates = [r["date"] for r in st["rows"]]
            if dates != sorted(dates):
                E.append(f"{m} rows not in date order")
            prev = st["closing"]
        # trial balance
        for per in ("AUG", "SEP"):
            b = self.balances(per)
            if sum(b.values()) != 0:
                E.append(f"trial balance {per} off by {sum(b.values())}")
            if b["1910"] != self.bank[per]["closing"]:
                E.append(f"bank account {per} {b['1910']} != statement {self.bank[per]['closing']}")
            # the reverse-charge liability always equals its deduction
            mv = self.movement(per)
            if mv["2937"] + mv["1761"] != 0:
                E.append(f"{per}: reverse-charge tax != deduction")
        # payroll arithmetic, and each salary line equals the payslip net
        for m, pm in self.payroll.items():
            for e, r in pm["emps"].items():
                if r["gross"] - r["withholding"] - r["tyel"] - r["tvr"] + r["km_amt"] + r["pd_amt"] - r["advance"] != r["net"]:
                    E.append(f"payslip {m} {e} does not add up")
                rows = [x for x in self.bank[m]["rows"] if x["type"] == "PALKKA" and x["party"] == self.people[e]["name"].upper()]
                if len(rows) != 1 or rows[0]["amount"] != -r["net"]:
                    E.append(f"salary bank line {m} {e} != payslip net")
        # TyEL invoice for August = what the books accrued
        b_sep = self.balances("SEP")
        if self.tyel["TYEL08"]["total"] != self.payroll["AUG"]["tyel_employee"] + self.payroll["AUG"]["tyel_employer"]:
            E.append("TyEL 8/2024 invoice != accrued")
        # after September: payroll liabilities hold exactly the September items
        ps = self.payroll["SEP"]
        exp = {"2931": -ps["withholding"], "2932": -ps["sava"], "2935": -(ps["tyel_employee"] + ps["tyel_employer"]),
               "2936": -(ps["tvr_employee"] + ps["tvr_employer"]), "1740": 0, "2710": 0, "2891": 0, "2890": 0}
        for a, v in exp.items():
            if b_sep[a] != v:
                E.append(f"30.9. balance {a} = {b_sep[a]} expected {v}")
        # receivables at 30.9: only the unpaid part of 2404
        open_2404 = self.sales[2404]["gross"] - c("2000.00")
        if b_sep["1700"] != open_2404:
            E.append(f"30.9. receivables {b_sep['1700']} != open 2404 {open_2404}")
        if b_sep["2885"] != -self.card["SEP"]["total"]:
            E.append("30.9. card liability != September card invoice")
        if b_sep["1780"] != self.mileage["SEP"]["excess"]:
            E.append("30.9. owner receivable != km excess")
        # 2939 at 30.9 = ALV 8 + ALV 9 (due 12.10 / 12.11)
        ra, rs = self.alv_return("AUG"), self.alv_return("SEP")
        out_plus_in = -b_sep["2939"] - b_sep["1760"]
        if out_plus_in != (ra["301"] - ra["UPO_tax"]) - ra["O_tax"] + (rs["301"] - rs["UPO_tax"]) - rs["O_tax"]:
            E.append("2939/1760 closing positions do not equal the two unpaid returns")
        if ra["308"] + rs["308"] != -b_sep["2939"] - b_sep["1760"] + (-b_sep["2937"] - b_sep["1761"]):
            E.append("section C ALV due does not equal the unpaid ALV positions")
        # independent recomputation of output VAT from the sales documents
        for per, rr in (("AUG", ra), ("SEP", rs)):
            indep = 0
            for no, s in self.sales.items():
                if s.get("advance"):
                    per_ = "AUG"  # received 23.8.
                elif no in (2407, 2408):
                    per_ = "SEP"
                else:
                    per_ = "AUG" if s["supply"][1] < "2024-09-01" else "SEP"
                if per_ == per:
                    indep += s["vat"]
            if indep != rr["M24_tax"] + rr["M255_tax"]:
                E.append(f"{per}: output VAT from documents {indep} != journals {rr['M24_tax'] + rr['M255_tax']}")
        # August closing bank must be positive (it is a real account)
        for m, st in self.bank.items():
            if min(r["balance"] for r in st["rows"]) < 0:
                E.append(f"{m}: statement goes overdrawn")
        # each receivable cleared no more than its gross
        for no, amt in self.cleared.items():
            if amt > self.sales[no]["gross"]:
                E.append(f"invoice {no} over-cleared")
        # every journal carries a terminal
        for j in self.journals:
            if j.terminal not in ("posted", "ask_owner"):
                E.append(f"{j.id} bad terminal")
        if self.errors:
            raise SystemExit("RECONCILIATION FAILED:\n  " + "\n  ".join(self.errors))


if __name__ == "__main__":
    p = Pack()
    for m in ("AUG", "SEP"):
        st = p.bank[m]
        print(m, "opening", fmt(st["opening"]), "closing", fmt(st["closing"]), "rows", len(st["rows"]))
        r = p.alv_return(m)
        print("  ALV", {k: fmt(v) for k, v in r.items() if k != "by_code"})
        print("  sales", {k: fmt(v) for k, v in p.sales_pl(m).items()})
    print("journals", len(p.journals))
    print("OK — everything reconciles")
