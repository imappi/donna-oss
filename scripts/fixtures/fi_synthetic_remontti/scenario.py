# Synthetic Finnish test pack — Remonttipalvelu Kivijärvi Oy, August–September 2024.
#
# THIS IS THE ONE DATA FILE. Everything in the pack (every PDF/JPG and the
# answer key) is rebuilt from it by build.py. Edit here, rebuild, and the
# checker in build.py fails loudly if anything stops reconciling.
#
# Conventions
#   * Money is written as strings in euros ("1234.56") and converted to integer
#     cents by build.py — no floats anywhere.
#   * VAT rates are strings: "24", "25.5", "14", or "RC" (construction reverse
#     charge, AVL 8 c §) / "0" (outside the scope of VAT).
#   * Identifiers are BASES: build.py computes the check digit (Y-tunnus mod 11,
#     FI BBAN Luhn + IBAN mod 97, viitenumero 7-3-1, henkilötunnus mod 31) so
#     every identifier is formally valid.
#   * Everything here is fictional. The only real names are public institutions
#     (Verohallinto, Työllisyysrahasto) whose payment details here are SYNTHETIC.

PACK_SLUG = "fi-remontti-kivijarvi-2024-08-09"
MARK = "SYNTEETTINEN TESTIAINEISTO"

# ── Statutory / contractual rates used by the scenario (sources: README) ─────
RATES = {
    "alv_general_until_2024_08_31": "24",
    "alv_general_from_2024_09_01": "25.5",
    "alv_reduced_food_restaurant": "14",
    "km_allowance_2024_eur_per_km": "0.57",
    "per_diem_full_2024": "51.00",
    "per_diem_partial_2024": "24.00",
    "tyel_total_2024_pct": "24.85",
    "tyel_employee_17_52_pct": "7.15",
    "tyel_employee_53_62_pct": "8.65",
    "yel_2024_pct": "24.10",
    "tvr_employee_2024_pct": "0.79",
    "tvr_employer_2024_pct": "0.27",
    "sava_employer_2024_pct": "1.16",
    "tax_late_interest_2024_pct": "11.0",
    "insurance_premium_tax_from_2024_09_01_pct": "25.5",
}

BANK = {
    "name": "Keski-Suomen Yrityspankki Oy",
    "short": "KSYP",
    "bic": "KSYPFIHH",
    "address": "Kauppakatu 18, 40100 JYVÄSKYLÄ",
    "service": "Yritysasiakaspalvelu 010 555 0100 · ksyp.example",
}

COMPANY = {
    "name": "Remonttipalvelu Kivijärvi Oy",
    "ytunnus_base": "3317452",
    "address": ["Kuormaajankatu 3", "40320 JYVÄSKYLÄ"],
    "phone": "040 555 1482",
    "email": "janne@remonttikivijarvi.example",
    "bban13": "4700100012345",  # the company's account at KSYP
    "tax_ref_base": "7033174521",   # oma-aloitteisten verojen viitenumero (base)
    "card_mask": "**** **** **** 4417",
    "owner": "owner",
    "basis": "Suoriteperuste, ALV-kausi 1 kk, tilikausi 1.1.–31.12.2024",
}

PEOPLE = {
    # henkilötunnus bases use the 900–999 individual-number range, which is
    # reserved for test/temporary identifiers and never assigned to real people.
    "owner": {"name": "Janne Kivijärvi", "hetu_base": "140379-913", "role": "toimitusjohtaja, omistaa 100 % osakkeista (YEL-vakuutettu)",
              "home": ["Pihlajakatu 11 B 6", "40520 JYVÄSKYLÄ"], "bban13": "4700200098765"},
    "e1": {"name": "Mikko Lahtinen", "hetu_base": "220890-947", "role": "rakennustyöntekijä", "age": 34,
           "tax_pct": "18.5", "hourly": "17.80", "bban13": "4700300045612",
           "home": ["Kuokkalantie 22 A 3", "40520 JYVÄSKYLÄ"]},
    "e2": {"name": "Ari Haapala", "hetu_base": "030568-958", "role": "rakennustyöntekijä, työnjohtaja", "age": 56,
           "tax_pct": "22.0", "hourly": "19.40", "bban13": "4700300078234",
           "home": ["Palokankaantie 5", "40270 PALOKKA"]},
}

# Counterparties. kind drives the answer key only for narrative; the VAT
# treatment of each document is stated on the document itself.
PARTIES = {
    "harjuntaus": {"name": "Rakennus Oy Harjuntaus", "ytunnus_base": "2894451", "address": ["Sepänkatu 4", "40320 JYVÄSKYLÄ"],
                   "kind": "construction_business", "bban13": "4700400011229"},
    "rautio": {"name": "Kattoasennus Rautio Oy", "ytunnus_base": "3128874", "address": ["Teollisuustie 9", "40950 MUURAME"],
               "kind": "construction_business", "bban13": "4700400033871"},
    "kotikallio": {"name": "Asunto Oy Jyväskylän Kotikallio", "ytunnus_base": "0781265", "address": ["c/o Isännöinti Keskustori Oy", "Väinönkatu 30", "40100 JYVÄSKYLÄ"],
                   "kind": "housing_company", "bban13": "4700400055913"},
    "salonen": {"name": "Leena Salonen", "address": ["Mäkiharjuntie 12", "40640 JYVÄSKYLÄ"], "kind": "consumer", "bban13": "4700500012004"},
    "rinne": {"name": "Marjatta Rinne", "address": ["Ristikiventie 3", "40520 JYVÄSKYLÄ"], "kind": "consumer", "bban13": "4700500029987"},
    "vaananen": {"name": "Tuomas Väänänen", "address": ["Kanervatie 8", "40630 JYVÄSKYLÄ"], "kind": "consumer"},
    "rtks": {"name": "Rakennustarvike Keski-Suomi Oy", "ytunnus_base": "2240197", "address": ["Tukkutie 21", "40320 JYVÄSKYLÄ"],
             "bban13": "4700600010101", "phone": "014 555 2200"},
    "ranta": {"name": "Sähköasennus Ranta Oy", "ytunnus_base": "2977311", "address": ["Voimalankatu 2", "40320 JYVÄSKYLÄ"], "bban13": "4700600020246"},
    "salmela": {"name": "Laatoitus Salmela Oy", "ytunnus_base": "3050683", "address": ["Keramiikkatie 7", "41160 TIKKAKOSKI"], "bban13": "4700600030391"},
    "konevuokra": {"name": "Konevuokraamo Jyväs Oy", "ytunnus_base": "2611734", "address": ["Varikkotie 5", "40320 JYVÄSKYLÄ"],
                   "bban13": "4700600040536", "wrong_bban13": "4700600040573"},
    "nordvan": {"name": "Nordvan Leasing Oy", "ytunnus_base": "2755080", "address": ["Autokatu 1", "33100 TAMPERE"], "bban13": "4700600050681"},
    "linja": {"name": "Linjaverkko Oy", "ytunnus_base": "1870423", "address": ["PL 400", "00051 LINJAVERKKO"], "bban13": "4700600060826"},
    "kateva": {"name": "Kätevä Kirjanpito Oy", "ytunnus_base": "3021997", "address": ["Pilvikuja 3", "90100 OULU"], "bban13": "4700600070971"},
    "tourula": {"name": "Varastokiinteistö Tourula Oy", "ytunnus_base": "2410538", "address": ["Tourulantie 15", "40100 JYVÄSKYLÄ"], "bban13": "4700600081116"},
    "kotiseutu": {"name": "Keskinäinen Vakuutusyhtiö Kotiseutu", "ytunnus_base": "0198746", "address": ["Vakuutuskuja 1", "00100 HELSINKI"], "bban13": "4700600091261"},
    "kantele": {"name": "Keskinäinen Työeläkevakuutusyhtiö Kantele", "ytunnus_base": "0977218", "address": ["Eläkepolku 2", "00240 HELSINKI"], "bban13": "4700600101406"},
    "tvr": {"name": "Työllisyysrahasto", "address": ["PL 191", "00181 HELSINKI"], "bban13": "4700600111551", "real_institution": True},
    "vero": {"name": "Verohallinto", "address": ["Oma-aloitteiset verot"], "bban13": "4700600121696", "real_institution": True},
    "kssahko": {"name": "Keski-Suomen Sähkönmyynti Oy", "ytunnus_base": "2355021", "address": ["Energiatie 4", "40100 JYVÄSKYLÄ"], "bban13": "4700600131841"},
    "hamalainen": {"name": "Kuljetus ja Maansiirto T. Hämäläinen", "ytunnus_base": "2566893", "address": ["Soratie 14", "41340 LAUKAA"]},
    "rautamaailma": {"name": "RautaMaailma Seppälä", "ytunnus_base": "2688145", "address": ["Seppäläntie 40", "40320 JYVÄSKYLÄ"]},
    "tankki_palokka": {"name": "Tankki Palokka", "ytunnus_base": "2799437", "address": ["Palokankaantie 60", "40270 PALOKKA"]},
    "tankki_kuokkala": {"name": "Tankki Kuokkala", "ytunnus_base": "2799437", "address": ["Kuokkalantie 70", "40520 JYVÄSKYLÄ"]},
    "parkkinyt": {"name": "ParkkiNyt Oy", "ytunnus_base": "3099153", "address": ["Mobiilitie 1", "00520 HELSINKI"]},
    "lounaskeidas": {"name": "Lounaskeidas Vasaramäki", "ytunnus_base": "3165428", "address": ["Vasarakatu 30", "40320 JYVÄSKYLÄ"]},
    "sitemeasure": {"name": "SiteMeasure Inc.", "address": ["500 Congress Avenue, Suite 900", "Austin, TX 78701, USA"]},
    "elektronetti": {"name": "ElektroNetti Oy (verkkokauppa)"},
    "sumup": {"name": "SumUp (korttimaksupalvelu)"},
}

# ── Opening balances 31.7.2024 (from the previous bookkeeping; doc 03) ───────
OPENING = {
    "date": "2024-07-31",
    "bank": "18450.62",
    "equipment": "14200.00",
    "prepaid_rent_aug": "850.00",
    "receivables": [{"no": 2398, "party": "harjuntaus", "date": "2024-07-19", "due": "2024-08-02",
                     "text": "Rakentamispalvelu 7/2024 (käännetty verovelvollisuus)", "amount": "3720.00"}],
    "loan": "18500.00",
    "alv_payable": [{"period": "6/2024", "due": "2024-08-12", "amount": "1846.20"},
                    {"period": "7/2024", "due": "2024-09-12", "amount": "2212.54"}],
    "withholding_july": "1118.62",
    "payroll_july_gross": "5763.20",
    "payroll_may_gross": "5610.00",
    "payroll_june_gross": "5902.60",
    "card_july": "431.25",
    "share_capital": "2500.00",
}

# ── Sales invoices ──────────────────────────────────────────────────────────
# line = (description, qty, unit, unit price, rate, kind) ; kind: tyo | aine
SALES = [
    {"no": 2401, "party": "harjuntaus", "date": "2024-08-16", "due": "2024-08-30", "supply": ("2024-08-05", "2024-08-15"),
     "site": "Työmaa 2417, Asemakatu 7, Jämsä (pääurakoitsija Rakennus Oy Harjuntaus)", "your_ref": "Tilaus TM2417-08",
     "lines": [("Väliseinien purku, työ", "64", "h", "42.00", "RC", "tyo"),
               ("Kevytrakenteisten väliseinien runkotyö, työ", "36", "h", "42.00", "RC", "tyo")]},
    {"no": 2402, "party": "salonen", "date": "2024-08-19", "due": "2024-08-26", "advance": True,
     "site": "Kylpyhuoneremontti, Mäkiharjuntie 12 (urakkasopimus 12.8.2024, urakkahinta 9 400,00 € + ALV)",
     "lines": [("Ennakkomaksu materiaalitilausta varten (urakkasopimuksen maksuerä 1)", "1", "erä", "2000.00", "24", "aine")]},
    {"no": 2403, "party": "rautio", "date": "2024-08-20", "due": "2024-09-03", "supply": ("2024-08-12", "2024-08-14"),
     "site": "Työmaa Muurame, Kauppatie 3 (Kattoasennus Rautio Oy:n urakka)", "your_ref": "Rautio / K. Rautio",
     "lines": [("Vesikaton läpivientien tiivistystyö, työ", "30", "h", "45.00", "24", "tyo"),
               ("Tiivistystarvikkeet ja läpivientikaulukset", "1", "erä", "500.00", "24", "aine")]},
    {"no": 2404, "party": "kotikallio", "date": "2024-08-26", "due": "2024-09-09", "supply": ("2024-08-12", "2024-08-22"),
     "site": "Asunto Oy Jyväskylän Kotikallio, porrashuone B", "your_ref": "Hallituksen päätös 6.8.2024",
     "lines": [("Porrashuone B: seinien paikkaus ja maalaus, työ", "72", "h", "40.00", "24", "tyo"),
               ("Maalit, tasoitteet ja suojaustarvikkeet", "1", "erä", "720.00", "24", "aine")]},
    {"no": 2405, "party": "rinne", "date": "2024-09-03", "due": "2024-09-17", "supply": ("2024-08-26", "2024-08-29"),
     "site": "Omakotitalo, Ristikiventie 3 — terassi", "household": True,
     "lines": [("Terassin lahonneiden lautojen vaihto ja kaiteen korjaus, työ", "25", "h", "46.00", "24", "tyo"),
               ("Painekyllästetty terassilauta 28x120, jm", "96", "jm", "5.00", "24", "aine"),
               ("Ruuvit, kulmaraudat ja puuöljy", "1", "erä", "160.00", "24", "aine")]},
    {"no": 2406, "party": "salonen", "date": "2024-09-10", "due": "2024-09-24", "supply": ("2024-08-26", "2024-09-06"),
     "site": "Kylpyhuoneremontti, Mäkiharjuntie 12 (urakkasopimus 12.8.2024) — valmistunut ja luovutettu 6.9.2024", "household": True,
     "advance_of": 2402,
     "lines": [("Kylpyhuoneremontti, työ (purku, vedeneristys, laatoitus, kalusteasennus)", "1", "urakka", "6200.00", "25.5", "tyo"),
               ("Materiaalit, ennakkolaskun 2402 ylittävä osa", "1", "erä", "1200.00", "25.5", "aine")]},
    {"no": 2407, "party": "rautio", "date": "2024-09-11", "due": "2024-09-11", "credit_of": 2403, "supply": ("2024-08-12", "2024-08-14"),
     "site": "Hyvitämme laskun 2403 kokonaisuudessaan: laskussa oli virheellisesti arvonlisävero. Rakentamispalvelun ostaja on verovelvollinen (AVL 8 c §). Oikaistu lasku 2408.",
     "lines": [("HYVITYS: Vesikaton läpivientien tiivistystyö, työ", "-30", "h", "45.00", "24", "tyo"),
               ("HYVITYS: Tiivistystarvikkeet ja läpivientikaulukset", "-1", "erä", "500.00", "24", "aine")]},
    {"no": 2408, "party": "rautio", "date": "2024-09-11", "due": "2024-09-25", "supply": ("2024-08-12", "2024-08-14"), "corrects": 2403,
     "site": "Työmaa Muurame, Kauppatie 3 — OIKAISTU LASKU (korvaa laskun 2403, hyvitys 2407)", "your_ref": "Rautio / K. Rautio",
     "lines": [("Vesikaton läpivientien tiivistystyö, työ", "30", "h", "45.00", "RC", "tyo"),
               ("Tiivistystarvikkeet ja läpivientikaulukset", "1", "erä", "500.00", "RC", "aine")]},
    {"no": 2409, "party": "harjuntaus", "date": "2024-09-16", "due": "2024-09-30", "supply": ("2024-09-02", "2024-09-13"),
     "site": "Työmaa 2417, Asemakatu 7, Jämsä (pääurakoitsija Rakennus Oy Harjuntaus)", "your_ref": "Tilaus TM2417-09",
     "lines": [("Kipsilevytys ja saumaus, työ", "96", "h", "42.00", "RC", "tyo"),
               ("Akustolevykaton asennus, työ", "32", "h", "49.00", "RC", "tyo")]},
    {"no": 2410, "party": "vaananen", "date": "2024-09-18", "due": "2024-09-18", "supply": ("2024-09-18", "2024-09-18"), "household": True,
     "paid_by_card": "2024-09-18",
     "site": "Omakotitalo, Kanervatie 8 — ulko-ovi",
     "lines": [("Ulko-oven säätö ja kynnyksen vaihto, työ", "8", "h", "47.50", "25.5", "tyo"),
               ("Tammikynnys 92 cm ja oven tiivistesarja", "1", "erä", "96.00", "25.5", "aine")]},
]

# ── Purchase invoices ───────────────────────────────────────────────────────
# line = (description, qty, unit, unit price, rate, account)
PURCHASES = [
    {"id": "P58811", "no": "58811", "party": "rtks", "date": "2024-08-05", "due": "2024-08-19", "delivered": "2024-08-05", "viite_base": "5881104",
     "title": "LASKU", "note": "Toimitus työmaille Kotikallio (porrashuone B) ja Muurame. Maksuehto 14 pv netto.",
     "lines": [("Sisämaali himmeä 9 l", "6", "kpl", "64.90", "24", "4000"),
               ("Kalkkitasoite 15 l", "5", "kpl", "29.80", "24", "4000"),
               ("Maalarinteippi 50 mm", "12", "rll", "6.40", "24", "4000"),
               ("Suojapaperi 1 x 25 m", "4", "rll", "18.90", "24", "4000"),
               ("Maalitela ja varsi", "6", "kpl", "12.50", "24", "4000"),
               ("Läpivientikaulus, bitumikate", "10", "kpl", "29.90", "24", "4000"),
               ("Tiivistysmassa 290 ml", "20", "kpl", "8.90", "24", "4000")]},
    {"id": "P59240", "no": "59240", "party": "rtks", "date": "2024-09-02", "due": "2024-09-16", "delivered": "2024-08-28", "viite_base": "5924007",
     "title": "LASKU", "note": "Tavarat toimitettu työmaalle Mäkiharjuntie 12 keskiviikkona 28.8.2024 (lähete 71120). Arvonlisävero toimituspäivän mukaan.",
     "lines": [("Seinälaatta 20x40 valkoinen, m²", "18", "m²", "34.90", "24", "4000"),
               ("Lattialaatta 10x10 harmaa, m²", "5", "m²", "52.00", "24", "4000"),
               ("Vedeneristyssarja 7 kg", "2", "kpl", "119.00", "24", "4000"),
               ("Laattalaasti 25 kg", "8", "säk", "24.50", "24", "4000"),
               ("Saumalaasti 5 kg", "4", "kpl", "19.90", "24", "4000"),
               ("Lattiakaivo ja korotusrengas", "1", "kpl", "189.00", "24", "4000"),
               ("Suihkukalustesarja termostaatilla", "1", "kpl", "420.00", "24", "4000")]},
    {"id": "P59377", "no": "59377", "party": "rtks", "date": "2024-09-10", "due": "2024-09-10", "delivered": "2024-09-09", "credit_of": "59240",
     "title": "HYVITYSLASKU", "note": "Palautus 9.9.2024, alkuperäinen lasku 59240 (toimitus 28.8.2024). Hyvitys alkuperäisen toimituksen verokannalla 24 %. Palautamme summan tilillenne.",
     "lines": [("PALAUTUS: Seinälaatta 20x40 valkoinen, m²", "-4", "m²", "34.90", "24", "4000"),
               ("PALAUTUS: Laattalaasti 25 kg", "-2", "säk", "24.50", "24", "4000")]},
    {"id": "P59611", "no": "59611", "party": "rtks", "date": "2024-09-12", "due": "2024-09-26", "delivered": "2024-09-12", "viite_base": "5961102",
     "title": "LASKU", "note": "Ostohyvitys (bonus) 1–6/2024 on laskettu 1.1.–30.6.2024 ostoista, jotka on verotettu 24 %:n verokannalla.",
     "lines": [("Kipsilevy 12,5 mm 1200x2600", "40", "kpl", "11.90", "25.5", "4000"),
               ("Kipsiruuvi 3,9x35, 1000 kpl", "4", "rs", "24.90", "25.5", "4000"),
               ("Saumanauha ja saumatasoite 15 l", "6", "kpl", "26.50", "25.5", "4000"),
               ("Tammikynnys 92 cm", "1", "kpl", "48.00", "25.5", "4000"),
               ("Oven tiivistesarja", "2", "kpl", "14.50", "25.5", "4000"),
               ("Ostohyvitys (bonus) 1–6/2024, 2 % ostoista", "1", "erä", "-86.00", "24", "4000")]},
    {"id": "P59702", "no": "59702", "party": "rtks", "date": "2024-09-19", "due": "2024-10-03", "delivered": "2024-09-19", "viite_base": "5970208",
     "title": "LASKU", "note": "Toimitus työmaalle 2417, Asemakatu 7, Jämsä.",
     "lines": [("Akustolevy 600x600", "48", "kpl", "7.40", "25.5", "4000"),
               ("Kiinnitysranka", "12", "kpl", "6.80", "25.5", "4000")]},
    {"id": "P1187", "no": "1187", "party": "ranta", "date": "2024-08-15", "due": "2024-08-29", "delivered": "2024-08-08", "viite_base": "118705",
     "title": "LASKU", "reverse_charge": True, "note": "Työ suoritettu 6.–8.8.2024, As Oy Jyväskylän Kotikallio, porrashuone B.",
     "lines": [("Porrashuone B: valaisinasennukset ja kytkennät, työ", "12", "h", "48.00", "RC", "4450"),
               ("Asennustarvikkeet", "1", "erä", "104.00", "RC", "4450")]},
    {"id": "P2024066", "no": "2024-066", "party": "salmela", "date": "2024-09-09", "due": "2024-09-23", "delivered": "2024-09-05", "viite_base": "2024066",
     "title": "LASKU", "reverse_charge": True, "note": "Työ tehty 29.8.–5.9.2024, kohde Mäkiharjuntie 12 (tilaajan asiakas: kuluttaja). Työ valmistunut 5.9.2024.",
     "lines": [("Kylpyhuoneen vedeneristys ja laatoitus, työ (urakka)", "1", "urakka", "2350.00", "RC", "4450")]},
    {"id": "P40118", "no": "40118", "party": "konevuokra", "date": "2024-09-09", "due": "2024-09-23", "delivered": "2024-09-06", "viite_base": "4011802",
     "title": "LASKU", "wrong_rate": True, "note": "Vuokra-aika 2.9.–6.9.2024, palautus 6.9.2024.",
     "lines": [("Piikkauskone 10 kg, vuorokausivuokra", "5", "vrk", "48.00", "24", "7400"),
               ("Rakennusimuri M-luokka, vuorokausivuokra", "5", "vrk", "36.00", "24", "7400"),
               ("Kuljetus työmaalle ja takaisin", "1", "krt", "120.00", "24", "7400")]},
    {"id": "PNV08", "no": "NV-2024-08-3317", "party": "nordvan", "date": "2024-08-01", "due": "2024-08-05", "delivered": "2024-08-31", "viite_base": "33170824",
     "title": "LASKU", "period": "1.8.–31.8.2024", "note": "Leasingkohde: pakettiauto (ajoneuvoluokka N1), rek. RKV-248. Sopimus 3317/2023.",
     "lines": [("Leasingvuokra 8/2024, pakettiauto N1 RKV-248", "1", "kk", "520.00", "24", "7300"),
               ("Huolto- ja rengassopimus 8/2024", "1", "kk", "45.00", "24", "7300")]},
    {"id": "PNV09", "no": "NV-2024-09-3317", "party": "nordvan", "date": "2024-09-01", "due": "2024-09-05", "delivered": "2024-09-30", "viite_base": "33170925",
     "title": "LASKU", "period": "1.9.–30.9.2024", "note": "Leasingkohde: pakettiauto (ajoneuvoluokka N1), rek. RKV-248. Sopimus 3317/2023. Yleinen ALV-kanta 25,5 % 1.9.2024 alkaen.",
     "lines": [("Leasingvuokra 9/2024, pakettiauto N1 RKV-248", "1", "kk", "520.00", "25.5", "7300"),
               ("Huolto- ja rengassopimus 9/2024", "1", "kk", "45.00", "25.5", "7300")]},
    {"id": "PLV07", "no": "8830-0724", "party": "linja", "date": "2024-08-02", "due": "2024-08-16", "delivered": "2024-07-31", "viite_base": "88300724",
     "title": "LASKU", "period": "1.7.–31.7.2024", "note": "Laskutuskausi 7/2024.",
     "lines": [("Yritysliittymä 5G, 2 kpl", "2", "kk", "24.90", "24", "7600"),
               ("Mobiililaajakaista 100 Gt", "1", "kk", "19.90", "24", "7600")]},
    {"id": "PLV08", "no": "8830-0824", "party": "linja", "date": "2024-09-03", "due": "2024-09-17", "delivered": "2024-08-31", "viite_base": "88300825",
     "title": "LASKU", "period": "1.8.–31.8.2024",
     "note": "Laskutuskausi 8/2024. Palvelu on toimitettu elokuussa, joten laskulla käytetään elokuussa voimassa ollutta 24 %:n verokantaa.",
     "lines": [("Yritysliittymä 5G, 2 kpl", "2", "kk", "24.90", "24", "7600"),
               ("Mobiililaajakaista 100 Gt", "1", "kk", "19.90", "24", "7600"),
               ("Ulkomaanpuhelut (Viro), 23 min", "1", "erä", "4.62", "24", "7600")]},
    {"id": "PKK08", "no": "KK-240801-552", "party": "kateva", "date": "2024-08-01", "due": "2024-08-15", "delivered": "2024-08-31", "viite_base": "2408015",
     "title": "LASKU", "period": "8/2024", "note": "Pilvipalvelu, kuukausimaksu.",
     "lines": [("Kätevä Pro -kirjanpito-ohjelmisto 8/2024", "1", "kk", "39.00", "24", "7650")]},
    {"id": "PKK09", "no": "KK-240901-552", "party": "kateva", "date": "2024-09-01", "due": "2024-09-15", "delivered": "2024-09-30", "viite_base": "2409014",
     "title": "LASKU", "period": "9/2024", "note": "Pilvipalvelu, kuukausimaksu. ALV 25,5 % 1.9.2024 alkaen.",
     "lines": [("Kätevä Pro -kirjanpito-ohjelmisto 9/2024", "1", "kk", "39.00", "25.5", "7650")]},
    {"id": "PVR09", "no": "V-2024-0917", "party": "tourula", "date": "2024-08-20", "due": "2024-08-30", "delivered": "2024-09-30", "viite_base": "20240917",
     "title": "VUOKRALASKU", "period": "1.9.–30.9.2024",
     "note": "Vuokranantaja on hakeutunut kiinteistön käyttöoikeuden luovutuksen arvonlisäverovelvolliseksi. Vuokra maksetaan kuukausittain etukäteen. Ennen 1.9.2024 maksettuun ennakkoon sovelletaan 24 %:n verokantaa.",
     "lines": [("Varastohallin ja toimiston vuokra 9/2024, Kuormaajankatu 3, halli 2 (240 m²)", "1", "kk", "850.00", "24", "1800")]},
    {"id": "PVR10", "no": "V-2024-1017", "party": "tourula", "date": "2024-09-20", "due": "2024-09-30", "delivered": "2024-10-31", "viite_base": "20241017",
     "title": "VUOKRALASKU", "period": "1.10.–31.10.2024",
     "note": "Vuokranantaja on hakeutunut kiinteistön käyttöoikeuden luovutuksen arvonlisäverovelvolliseksi. Vuokra maksetaan kuukausittain etukäteen.",
     "lines": [("Varastohallin ja toimiston vuokra 10/2024, Kuormaajankatu 3, halli 2 (240 m²)", "1", "kk", "850.00", "25.5", "1800")]},
    {"id": "PINS", "no": "KV-7741-2024-3", "party": "kotiseutu", "date": "2024-09-10", "due": "2024-09-26", "delivered": "2024-09-10", "viite_base": "77412403",
     "title": "VAKUUTUSLASKU", "insurance": True,
     "note": "Vakuutukset ovat arvonlisäverottomia (AVL 44 §). Vakuutusmaksuvero on eri vero kuin arvonlisävero, eikä sitä voi vähentää.",
     "lines": [("Lakisääteinen työtapaturma- ja ammattitautivakuutus, ennakkomaksu 3/4 2024", "1", "erä", "384.00", "0", "6150"),
               ("Yritysvastuuvakuutus 1.10.2024–30.9.2025, vakuutusmaksu", "1", "v", "460.00", "0", "1800"),
               ("Vakuutusmaksuvero 25,5 % (yritysvastuuvakuutus)", "1", "erä", "117.30", "0", "1800")]},
    {"id": "PSAHKO", "no": "55120724", "party": "kssahko", "date": "2024-07-29", "due": "2024-08-12", "delivered": "2024-07-31", "viite_base": "5512072",
     "title": "SÄHKÖLASKU", "private_to_owner": True, "period": "1.7.–31.7.2024",
     "note": "Käyttöpaikka: Pihlajakatu 11 B 6, 40520 Jyväskylä (asunto). Sopimus: Kotitalous, yleissähkö.",
     "lines": [("Sähköenergia 7/2024, 412 kWh", "412", "kWh", "0.0849", "24", "1780"),
               ("Perusmaksu 7/2024", "1", "kk", "4.90", "24", "1780")]},
]

# ── Payroll (monthly pay by local agreement; payday = last banking day) ─────
PAYROLL = {
    "AUG": {"payday": "2024-08-30", "period": ("2024-08-01", "2024-08-31"), "tr_reported": "2024-09-02",
            "e1": {"hours": "168", "km": "186", "per_diem_full": 0, "per_diem_partial": 0, "advance": "500.00"},
            "e2": {"hours": "160", "km": "0", "per_diem_full": 4, "per_diem_partial": 0,
                   "trips": "Työmatkat tilapäiselle työpaikalle Jämsä (yli 15 km, yli 10 h): 6.8., 7.8., 13.8., 14.8."}},
    "SEP": {"payday": "2024-09-30", "period": ("2024-09-01", "2024-09-30"), "tr_reported": "2024-10-02",
            "e1": {"hours": "176", "km": "144", "per_diem_full": 0, "per_diem_partial": 0, "advance": "0"},
            "e2": {"hours": "168", "km": "0", "per_diem_full": 3, "per_diem_partial": 1,
                   "trips": "Työmatkat tilapäiselle työpaikalle Jämsä: 3.9., 4.9., 10.9. (yli 10 h) ja 11.9. (yli 6 h)."}},
}
E1_KM_ROUTES = {
    "AUG": "Omalla autolla työmaiden välillä: Kotikallio – Muurame – Tukkutie – Ristikiventie (ajopäiväkirja liitteenä palkanlaskentaan)",
    "SEP": "Omalla autolla työmaiden välillä: Mäkiharjuntie – Kanervatie – Tukkutie",
}
SALARY_ADVANCE = {"date": "2024-08-15", "employee": "e1", "amount": "500.00"}

# ── Owner's private car: mileage log (ajopäiväkirja), claim paid 30.9 ───────
# (date, route, km, purpose, commuting?)
MILEAGE_LOG = [
    ("2024-08-02", "Koti – RautaMaailma Seppälä – työmaa Kotikallio – koti", "34", "Tarvikehankinta, työmaakäynti", False),
    ("2024-08-06", "Koti – työmaa Jämsä (Harjuntaus / aloituspalaveri) – koti", "132", "Työmaapalaveri, tilapäinen työpaikka", False),
    ("2024-08-12", "Koti – työmaa Muurame – koti", "46", "Työmaan aloitus, Rautio", False),
    ("2024-08-20", "Koti – Lounaskeidas (neuvottelu) – Kotikallio – koti", "28", "Asiakasneuvottelu As Oy Kotikallio", False),
    ("2024-08-27", "Koti – RautaMaailma – työmaa Ristikiventie – koti", "38", "Tarvikkeet Rinteen terassille", False),
    ("2024-08-29", "Koti – työmaa Ristikiventie – Mäkiharjuntie – koti", "40", "Terassin luovutus, kylpyhuoneen aloitus", False),
    ("2024-09-03", "Koti – työmaa Jämsä – koti", "132", "Työmaakokous Harjuntaus", False),
    ("2024-09-05", "Koti – Kuormaajankatu 3 (oma halli) – koti", "18", "Varaston avaus aamulla", True),
    ("2024-09-06", "Koti – työmaa Mäkiharjuntie (luovutus) – koti", "24", "Kylpyhuoneen luovutus", False),
    ("2024-09-11", "Koti – työmaa Muurame – koti", "46", "Oikaistun laskun läpikäynti Rautio", False),
    ("2024-09-18", "Koti – työmaa Kanervatie – Tukkutie – koti", "36", "Väänäsen ulko-ovi, tarvikkeet", False),
    ("2024-09-24", "Koti – Konevuokraamo – työmaa Mäkiharjuntie – koti", "38", "Kalustoasiat, työmaakäynti", False),
]

# ── Owner-paid cash purchase (handwritten receipt) ──────────────────────────
CASH_RECEIPT = {"date": "2024-08-27", "party": "hamalainen", "text": "Sepeli 6–16 mm 2 m³ + kuljetus, Ristikiventie 3 (Rinne)",
                "gross": "120.00", "rate": "24", "account": "4000"}

# ── Company credit card (KSYP Yritys Visa) ─────────────────────────────────
# Each purchase: receipt items are GROSS (receipts price VAT-inclusive).
CARD = {
    "AUG": {"invoice_date": "2024-09-02", "due": "2024-09-16", "period": ("2024-08-01", "2024-08-31"), "viite_base": "44170824",
            "purchases": [
                {"id": "C0802", "date": "2024-08-02", "merchant": "rautamaailma", "stmt": "RAUTAMAAILMA SEPPALA JYVASKYLA", "rate": "24", "account": "4000",
                 "items": [("RUUVI 5X70 PUU 500KPL", "1", "34.90"), ("SAUMAUSMASSA VALK", "2", "12.90"), ("SUOJAMUOVI 4X5M", "1", "18.90"), ("HIOMAPAPERI P120", "1", "6.80")],
                 "receipt": "photo_rotated", "time": "13:12"},
                {"id": "C0806", "date": "2024-08-06", "merchant": "tankki_palokka", "stmt": "TANKKI PALOKKA JYVASKYLA", "rate": "24", "account": "7310",
                 "fuel": ("DIESEL", "51.62", "1.789"), "receipt": "scan_faded", "time": "07:41"},
                {"id": "C0809", "date": "2024-08-09", "merchant": "parkkinyt", "stmt": "PARKKINYT.FI HELSINKI", "rate": "24", "account": "7830",
                 "items": [("Pysäköinti Kauppakatu, vyöhyke 1, 1 h 55 min", "1", "4.80")], "receipt": "email", "time": "10:05"},
                {"id": "C0814", "date": "2024-08-14", "merchant": "elektronetti", "stmt": "ELEKTRONETTI.FI VERKKOKAUPPA", "rate": None, "account": "1780",
                 "items": [("Pelikonsolin ohjain + peli (yksityinen)", "1", "139.80")], "receipt": None, "private": True},
                {"id": "C0820", "date": "2024-08-20", "merchant": "lounaskeidas", "stmt": "LOUNASKEIDAS VASARAMAKI", "rate": "14", "account": "7780",
                 "items": [("LOUNAS BUFFET", "2", "13.80"), ("KAHVI + PULLA", "2", "5.50")], "receipt": "photo_note", "time": "12:18",
                 "note": "Neuvottelu As Oy Kotikallio, hall. pj. R. N. — edustus / JK"},
                {"id": "C0822", "date": "2024-08-22", "merchant": "sitemeasure", "stmt": "SITEMEASURE.IO AUSTIN US", "rate": "UPO", "account": "7650",
                 "usd": "29.00", "fx": "1.0939", "fx_fee_pct": "1.70", "receipt": "english_invoice", "inv_no": "SM-INV-88213",
                 "service_period": "Aug 22 – Sep 21, 2024"},
                {"id": "C0827", "date": "2024-08-27", "merchant": "rautamaailma", "stmt": "RAUTAMAAILMA SEPPALA JYVASKYLA", "rate": "24", "account": "4000",
                 "items": [("TERASSIRUUVI 5X50 RST 250KPL", "2", "39.90"), ("PUUOLJY 2,7L", "2", "28.90"), ("KULMARAUTA 20KPL", "1", "16.50"), ("SAHANTERA 190MM", "1", "58.60")],
                 "receipt": "photo_duplicate", "time": "16:44"},
                {"id": "C0829", "date": "2024-08-29", "merchant": "tankki_kuokkala", "stmt": "TANKKI KUOKKALA JYVASKYLA", "rate": "24", "account": "7310",
                 "amount": "58.20", "receipt": None, "missing": True},
            ]},
    "SEP": {"invoice_date": "2024-10-01", "due": "2024-10-15", "period": ("2024-09-01", "2024-09-30"), "viite_base": "44170925",
            "purchases": [
                {"id": "C0903", "date": "2024-09-03", "merchant": "tankki_palokka", "stmt": "TANKKI PALOKKA JYVASKYLA", "rate": "25.5", "account": "7310",
                 "fuel": ("DIESEL", "48.72", "1.809"), "receipt": "scan_faded", "time": "06:58"},
                {"id": "C0910", "date": "2024-09-10", "merchant": "rautamaailma", "stmt": "RAUTAMAAILMA SEPPALA JYVASKYLA", "rate": "25.5", "account": "4000",
                 "items": [("PORANTERASARJA HSS 19OS", "1", "29.90"), ("JATKOJOHTO 10M IP44", "1", "24.90"), ("TYOKASINE NITRIILI", "3", "3.40")],
                 "receipt": "photo_lowcontrast", "time": "09:27"},
                {"id": "C0916", "date": "2024-09-16", "merchant": "parkkinyt", "stmt": "PARKKINYT.FI HELSINKI", "rate": "25.5", "account": "7830",
                 "items": [("Pysäköinti Väinönkatu, vyöhyke 1, 1 h 25 min", "1", "3.60")], "receipt": "email", "time": "14:10"},
                {"id": "C0922", "date": "2024-09-22", "merchant": "sitemeasure", "stmt": "SITEMEASURE.IO AUSTIN US", "rate": "UPO", "account": "7650",
                 "usd": "29.00", "fx": "1.1035", "fx_fee_pct": "1.70", "receipt": "english_invoice", "inv_no": "SM-INV-91377",
                 "service_period": "Sep 22 – Oct 21, 2024"},
            ]},
}

# ── Pension / insurance / tax institutions ─────────────────────────────────
YEL = {"work_income": "36000.00", "invoices": [
    {"id": "YEL08", "no": "YEL-3317-0824", "date": "2024-08-05", "due": "2024-08-20", "month": "8/2024", "viite_base": "96331708"},
    {"id": "YEL09", "no": "YEL-3317-0924", "date": "2024-09-05", "due": "2024-09-20", "month": "9/2024", "viite_base": "96331709"},
]}
TYEL = [
    {"id": "TYEL07", "no": "TYEL-3317-0724", "date": "2024-08-05", "due": "2024-08-20", "month": "7/2024", "viite_base": "95331707", "gross_from": "opening"},
    {"id": "TYEL08", "no": "TYEL-3317-0824", "date": "2024-09-05", "due": "2024-09-20", "month": "8/2024", "viite_base": "95331708", "gross_from": "AUG"},
]
TVR_INVOICE = {"id": "TVR", "no": "TVR-2024-3-3317452", "date": "2024-09-12", "due": "2024-09-26", "viite_base": "8033174523",
               "months": "5–8/2024"}

OMAVERO = {
    "late_payment": {"due": "2024-08-12", "paid": "2024-08-21"},
    "on_time": {"due": "2024-09-12", "paid": "2024-09-12"},
}

LOAN = {"no": "YL-4471-2023", "rate_pct": "5.35", "euribor_pct": "3.55", "margin_pct": "1.80", "principal_per_instalment": "500.00",
        "instalments": [{"date": "2024-08-28", "from": "2024-07-29", "to": "2024-08-28", "days": 31},
                        {"date": "2024-09-30", "from": "2024-08-29", "to": "2024-09-28", "days": 31, "note": "Eräpäivä 28.9.2024 on lauantai — veloitus seuraavana pankkipäivänä 30.9.2024."}]}

SUMUP = {"invoice": 2410, "tx_date": "2024-09-18", "settle_date": "2024-09-23", "fee_pct": "1.69", "tx_id": "TX-8FQ2-7731"}

OWNER_REPAY = {"date": "2024-09-10"}
OWNER_CLAIM_PAY = {"date": "2024-09-30"}
BANK_FEES = {"AUG": [("2024-08-30", "PALVELUMAKSUT", "Palvelupaketti Yritys 8/2024", "12.90")],
             "SEP": [("2024-09-23", "PALVELUMAKSU", "Palautuneen maksun käsittely", "5.00"),
                     ("2024-09-30", "PALVELUMAKSUT", "Palvelupaketti Yritys 9/2024", "12.90")]}

# Returned payment (our typo in the payee's IBAN)
RETURNED_PAYMENT = {"doc": "P40118", "first": "2024-09-19", "returned": "2024-09-23", "second": "2024-09-24",
                    "reason": "PALAUTUS: TILINUMERO EI KÄYTÖSSÄ"}

# Bank schedule: which document is paid/received on which day. Amounts are
# DERIVED from the documents (build.py) so the statement cannot drift from them.
BANK_SCHEDULE = {
    "AUG": [
        ("2024-08-02", "receipt_opening", 2398),
        ("2024-08-05", "pay", "PNV08"),
        ("2024-08-12", "pay", "PSAHKO"),
        ("2024-08-15", "salary_advance", None),
        ("2024-08-15", "pay", "PKK08"),
        ("2024-08-16", "card_opening", None),
        ("2024-08-16", "pay", "PLV07"),
        ("2024-08-19", "pay", "P58811"),
        ("2024-08-20", "yel", "YEL08"),
        ("2024-08-20", "tyel", "TYEL07"),
        ("2024-08-21", "omavero_aug", None),
        ("2024-08-23", "advance_received", 2402),
        ("2024-08-28", "loan", 0),
        ("2024-08-29", "pay", "P1187"),
        ("2024-08-30", "pay", "PVR09"),
        ("2024-08-30", "salary", ("AUG", "e1")),
        ("2024-08-30", "salary", ("AUG", "e2")),
        ("2024-08-30", "fees", 0),
    ],
    "SEP": [
        ("2024-09-05", "pay", "PNV09"),
        ("2024-09-10", "owner_repay", None),
        ("2024-09-12", "omavero_sep", None),
        ("2024-09-16", "card", "AUG"),
        ("2024-09-16", "pay", "P59240"),
        ("2024-09-16", "pay", "PKK09"),
        ("2024-09-17", "pay", "PLV08"),
        ("2024-09-17", "receipt", (2405,)),
        ("2024-09-19", "pay_wrong_iban", "P40118"),
        ("2024-09-20", "yel", "YEL09"),
        ("2024-09-20", "tyel", "TYEL08"),
        ("2024-09-20", "receipt_partial", (2404, "2000.00")),
        ("2024-09-20", "receipt", (2406,)),
        ("2024-09-23", "returned", "P40118"),
        ("2024-09-23", "fees", 0),
        ("2024-09-23", "receipt_rautio", (2408,)),
        ("2024-09-23", "pay", "P2024066"),
        ("2024-09-23", "sumup", 2410),
        ("2024-09-24", "pay_again", "P40118"),
        ("2024-09-25", "refund", "P59377"),
        ("2024-09-26", "pay_bundle", ("P59611", "P59702")),
        ("2024-09-26", "tvr", None),
        ("2024-09-26", "pay", "PINS"),
        ("2024-09-27", "receipt_bundle", (2401, 2409)),
        ("2024-09-30", "loan", 1),
        ("2024-09-30", "pay", "PVR10"),
        ("2024-09-30", "salary", ("SEP", "e1")),
        ("2024-09-30", "salary", ("SEP", "e2")),
        ("2024-09-30", "owner_claims", None),
        ("2024-09-30", "fees", 1),
    ],
}

# Owner's e-mail to the bookkeeper (doc 08) — the "email explaining a charge".
OWNER_EMAIL = {
    "date": "2024-09-09 21:47",
    "subject": "Elokuun kuitit + pari selitystä",
    "body": [
        "Moi,",
        "",
        "tässä elokuun ja syyskuun alun paperit. Pari juttua joista kysyit viimeksi:",
        "",
        "1) Yrityskortilla 14.8. ElektroNetti 139,80 € on mun oma ostos (pojan pelikonsolin ohjain ja peli). Meni vahingossa firman kortilla.",
        "2) Firman tililtä on 12.8. maksettu Keski-Suomen Sähkönmyynnin lasku 49,45 € — se on meidän kodin sähkö, e-lasku oli ohjautunut väärälle tilille. Korjasin e-laskusopimuksen.",
        "   Maksan molemmat takaisin firman tilille tällä viikolla.",
        "3) Maksoin 27.8. omalla rahalla käteisellä sepelikuorman Rinteen terassille (120 €), kuitti on mukana. Laita se mun kulukorvauksiin, maksan ne itselleni syyskuun lopussa yhdessä kilometrien kanssa.",
        "4) Rautio soitti, että meidän laskussa 2403 ei olisi saanut olla alvia kun ne on itsekin rakennusfirma. Teen heille hyvityksen ja uuden laskun ilman alvia.",
        "5) K-Raudan... siis RautaMaailman 27.8. kuitista otin varmuuden vuoksi kaksi kuvaa kun ensimmäinen oli vähän vino.",
        "",
        "YEL-maksut on maksettu firman tililtä niin kuin ennenkin.",
        "",
        "t. Janne",
        "",
        "Janne Kivijärvi · Remonttipalvelu Kivijärvi Oy · 040 555 1482",
    ],
}
