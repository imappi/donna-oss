"""Input data for the synthetic Finnish test pack "Karkkiaitta Oy, 12/2024-01/2025".

This is the ONE data file the generator (build.py) reads. It holds only
literals: people, identifiers, prices, quantities, dates, rates, and the
per-event facts a real owner's paperwork would carry. Everything derived
(VAT splits, payouts, statement balances, the answer key) is computed by
build.py, and build.py's checker refuses to write anything that does not
reconcile to the cent.

Money is written as strings and parsed to Decimal. Dates are "YYYY-MM-DD".
Rates are percent strings ("25.5").

EVERYTHING HERE IS FICTIONAL. Company, people, identifiers, accounts and
transactions are synthetic test data. Large platforms, public bodies and
pension insurers appear by name only, the way the Kultalanka pack uses them.
"""

# --------------------------------------------------------------------------
# Company and parties
# --------------------------------------------------------------------------

COMPANY = {
    "name": "Karkkiaitta Oy",
    "ytunnus": "3409812-2",
    "vat": "FI34098122",
    "address": ["Isokatu 41 B 12", "90100 OULU"],
    "warehouse": "Varasto: Kaarnatie 18, 90530 Oulu",
    "email": "tilaukset@karkkiaitta.example",
    "web": "karkkiaitta.example",
    "bank": "Merituuli Pankki Oyj",
    "bic": "MERTFIHH",
    "iban": "FI1279112000458025",
    "iban_display": "FI12 7911 2000 4580 25",
    "fy": "1.1.-31.12.",
    "vat_period": "kuukausi",
    "basis": "suoriteperuste",
    "founded": "2023",
}

FOUNDERS = [
    {"key": "liisa", "name": "Liisa Kärkkäinen", "role": "toimitusjohtaja, hallituksen jäsen",
     "share": "50", "yel_income": "30000.00", "iban": "FI5479112000459015"},
    {"key": "tuomas", "name": "Tuomas Rautio", "role": "hallituksen puheenjohtaja",
     "share": "50", "yel_income": "27600.00", "iban": "FI9640550100235619"},
]

EMPLOYEE = {
    "name": "Veera Nieminen",
    "born": "14.03.2001",
    "role": "Pakkaaja (osa-aikainen, tuntipalkka)",
    "iban": "FI4631400019876502",
    "employment": ["2024-11-25", "2025-01-31"],
    "hourly": "13.50",
    "evening_pct": "20",          # contractual evening supplement (Mon-Fri after 18:00)
    "sunday_pct": "100",          # sunnuntaityökorotus, työaikalaki
    "holiday_comp_pct": "9",      # vuosilomalaki: percentage-based, < 14 days/month by contract, employment < 1 year
    "taxcard": {"2024": "12.0", "2025": "14.5"},
}

BANK_NAME = "Merituuli Pankki Oyj"

CUSTOMER_B2B = {
    "name": "Pohjoisen Insinööritoimisto Oy",
    "ytunnus": "2981446-2",
    "address": ["Kauppurienkatu 12", "90100 OULU"],
    "contact": "Marja Heikkilä, HR",
    "iban": "FI6857800023456705",
}

SUPPLIERS = {
    "makeistukku": {"name": "Pohjolan Makeistukku Oy", "ytunnus": "1873452-0",
                    "address": ["Teollisuuskatu 7", "70620 KUOPIO"], "iban": "FI0412345600012343"},
    "kuusamo": {"name": "Kustannus Kuusamo Oy", "ytunnus": "2544107-2",
                "address": ["Kitkantie 22", "93600 KUUSAMO"], "iban": "FI4631400019876502"},
    "pakkaus": {"name": "Oulun Pakkaustarvike Oy", "ytunnus": "3011928-0",
                "address": ["Ruskontie 4", "90630 OULU"], "iban": "FI6857800023456705"},
    "huolinta": {"name": "Pohjanlahden Huolinta Oy", "ytunnus": "2210985-9",
                 "address": ["Satamatie 15", "94900 KEMI"], "iban": "FI0412345600012343"},
    "lokerikko": {"name": "Lokerikko Oy", "ytunnus": "3187364-8",
                  "address": ["Hatanpään valtatie 30", "33100 TAMPERE"], "iban": "FI5479112000459015"},
    "kirjuri": {"name": "Kirjuri Pilvi Oy", "ytunnus": "2765431-1",
                "address": ["Kauppakatu 19", "40100 JYVÄSKYLÄ"], "iban": "FI9640550100235619"},
    "revontuli": {"name": "Vakuutusosakeyhtiö Revontuli", "ytunnus": "3322109-6",
                  "address": ["Pakkahuoneenkatu 3", "90100 OULU"], "iban": "FI1279112000458025"},
    "thistle": {"name": "Thistle & Toffee Ltd", "address": ["Unit 4, Parkway Works", "Sheffield S9 3BL", "United Kingdom"],
                "vat": "GB 918 4411 27", "eori": "GB918441127000"},
    "hengfeng": {"name": "Hengfeng Porcelain Trading Co., Ltd.", "address": ["No. 88 Taoyang Road", "Jingdezhen, Jiangxi 333000", "China"]},
}

# IBAN checksum + account check digit of every FI IBAN above is verified by build.py.

# --------------------------------------------------------------------------
# Statutory parameters (sources + as-of dates in the fixture README)
# --------------------------------------------------------------------------

VAT = {
    # Finland. General rate 25.5 % since 1.9.2024. 1.1.2025: the 10 % rate for
    # books moved to 14 %. Confectionery, chocolate and soft drinks STAYED at
    # 14 % (the planned increase to 25.5 % was dropped by the government).
    "FI": {"candy": {"2024": "14", "2025": "14"}, "drink": {"2024": "14", "2025": "14"},
           "book": {"2024": "10", "2025": "14"}, "mug": {"2024": "25.5", "2025": "25.5"}},
    # Destination rates for OSS (Sweden, Germany), Dec 2024 - Jan 2025.
    "SE": {"candy": "12", "drink": "12", "book": "6", "mug": "25"},
    "DE": {"candy": "7", "drink": "19", "book": "7", "mug": "19"},
}

PAYROLL_RATES = {
    # by PAYMENT year (wages paid in the year)
    "2024": {"tyel_employee": "7.15", "tyel_employer": "17.66", "tvr_employee": "0.79",
             "tvr_employer": "0.27", "sava": "1.16"},
    "2025": {"tyel_employee": "7.15", "tyel_employer": "17.70", "tvr_employee": "0.59",
             "tvr_employer": "0.20", "sava": "1.87"},
}
YEL_RATE = "24.10"
TAX_LATE_INTEREST_2024 = "11.5"   # viivästyskorko 2024, UNVERIFIED (see README)
ACCIDENT_INS_RATE = "0.92"        # contractual, synthetic insurer

OSS_THRESHOLD = "10000.00"
EU_DISTANCE_SALES_2023 = "3105.00"
EU_DISTANCE_SALES_2024_JAN_NOV = "9412.00"   # net, both channels, per the web-shop EU export

# --------------------------------------------------------------------------
# Catalogue (consumer gross prices incl. Finnish VAT)
# --------------------------------------------------------------------------

PRODUCTS = {
    "K1": {"name": "Salmiakkisekoitus 500 g", "cat": "candy", "price": "8.90", "cost": "2.85"},
    "K2": {"name": "Suklaalajitelma 400 g", "cat": "candy", "price": "14.90", "cost": "5.40"},
    "K3": {"name": "Joulukalenteri, maitosuklaa 24 luukkua", "cat": "candy", "price": "12.90", "cost": "4.60"},
    "K4": {"name": "Lakritsilahjapussi 250 g", "cat": "candy", "price": "6.50", "cost": "2.10"},
    "K5": {"name": "Brittiläinen kermatoffee 200 g", "cat": "candy", "price": "7.90", "cost": "2.95"},
    "J1": {"name": "Karpalolimonadi 4 x 0,33 l", "cat": "drink", "price": "9.60", "cost": "3.20"},
    "B1": {"name": "Kirja: Suomalaisen makeisen tarina", "cat": "book", "price": "24.90", "cost": "11.20"},
    "B2": {"name": "Kirja: Karkkikeittiö - 60 reseptiä", "cat": "book", "price": "29.90", "cost": "13.10"},
    "M1": {"name": "Karkkiaitta-muki 3 dl", "cat": "mug", "price": "16.90", "cost": "4.10"},
    "G1": {"name": "Joulun Makea Lahjalaatikko", "cat": "box", "price": "59.90"},
    "GC": {"name": "Lahjakortti (monikäyttöinen)", "cat": "voucher"},
}

# Gift box: one K2 + one B1 + one M1 in a printed box. The single price is split
# by the components' purchase cost (5.40 / 11.20 / 4.10 = 20.70), the key's rule.
GIFT_BOX = {"components": [("K2", "candy"), ("B1", "book"), ("M1", "mug")],
            "b2b_net": "45.00"}

SHIPPING = {"posti": {"name": "Postipaketti", "price": "6.90"},
            "locker": {"name": "Pakettiautomaatti (Lokerikko)", "price": "5.90"},
            "eu": {"name": "EU-toimitus (Posti)", "price": "12.90"},
            "amazon": {"name": "Versand", "price": "4.99"}}

# Amazon.de list prices (gross, EUR)
AMAZON_PRICES = {"K2": "16.90", "K3": "13.90", "K1": "9.90", "B2": "32.90", "M1": "18.90", "K5": "8.90"}

# --------------------------------------------------------------------------
# Web shop: domestic bulk shipments per month (quantities, shipped in month)
# --------------------------------------------------------------------------

WEB_BULK = {
    "2024-12": {"qty": {"K1": 184, "K2": 141, "K3": 96, "K4": 162, "K5": 58, "J1": 61, "B1": 38, "B2": 27, "M1": 71, "G1": 64},
                "ship": {"posti": 214, "locker": 152}},
    "2025-01": {"qty": {"K1": 61, "K2": 36, "K3": 0, "K4": 57, "K5": 22, "J1": 26, "B1": 14, "B2": 12, "M1": 21, "G1": 9},
                "ship": {"posti": 88, "locker": 63}},
}

# Of the bulk gross: paid with a gift card, and paid with Klarna; the rest is Paytrail.
GIFTCARD_REDEEMED = {"2024-12": "240.00", "2025-01": "690.00"}
KLARNA_BULK_GROSS = {"2024-12": "4380.40", "2025-01": "1242.70"}

# Gift cards sold in the web shop (Paytrail), date -> amount. Multi-purpose vouchers.
GIFTCARDS_SOLD_WEB = [("2024-12-02", "150.00"), ("2024-12-09", "300.00"), ("2024-12-16", "450.00"),
                      ("2024-12-20", "350.00"), ("2024-12-22", "200.00")]

# Relative daily weights for spreading the Paytrail bulk and Klarna captures.
# Index 0 = 1st day of the month. Christmas peak mid-December; post-holiday dip.
DAY_WEIGHTS = {
    "2024-12": [4, 5, 5, 6, 6, 3, 5, 6, 7, 8, 8, 9, 9, 8, 9, 10, 11, 12, 13, 12, 10, 8, 4, 0, 0, 1, 3, 3, 2, 3, 1],
    "2025-01": [0, 3, 4, 3, 2, 2, 5, 4, 4, 4, 3, 2, 3, 4, 4, 3, 3, 3, 2, 3, 4, 3, 3, 3, 2, 2, 3, 3, 3, 3, 3],
}
KLARNA_WEIGHTS = {
    "2024-12": [2, 3, 3, 3, 3, 1, 3, 3, 4, 4, 5, 5, 5, 4, 5, 6, 6, 7, 7, 6, 5, 4, 2, 0, 0, 0, 1, 2, 1, 1, 0],
    "2025-01": [0, 2, 3, 2, 1, 1, 3, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 1, 1, 2, 2, 2, 2, 2],
}

# Paytrail gross 25.-30.11.2024 (already in the opening receivable, settled 2.12.)
PAYTRAIL_NOV_TAIL = [("2024-11-25", "412.30"), ("2024-11-26", "388.90"), ("2024-11-27", "455.10"),
                     ("2024-11-28", "501.60"), ("2024-11-29", "622.40"), ("2024-11-30", "310.20")]
KLARNA_NOV_TAIL = [("2024-11-25", "98.40"), ("2024-11-26", "112.30"), ("2024-11-27", "76.80"),
                   ("2024-11-28", "143.60"), ("2024-11-29", "188.20"), ("2024-11-30", "64.90")]

# Orders paid in the web shop (Paytrail) in December but shipped in January:
# the payment is an ADVANCE (ennakkomaksu) -> VAT due in December at the rate
# in force when the payment was received (books 10 %).
ADVANCE_ORDERS = [
    {"id": "W-24-1488", "paid": "2024-12-29", "shipped": "2025-01-02", "lines": [("B2", 1), ("K2", 2)], "ship": "posti"},
    {"id": "W-24-1490", "paid": "2024-12-30", "shipped": "2025-01-02", "lines": [("G1", 1)], "ship": "posti"},
    {"id": "W-24-1493", "paid": "2024-12-31", "shipped": "2025-01-03", "lines": [("K1", 3), ("M1", 1)], "ship": "locker"},
]
# Klarna order placed 30.12., captured (= paid to the merchant) on shipment 2.1.:
# no advance received in 2024 -> supply date rules -> books 14 %.
KLARNA_DEC_ORDER_JAN_SHIP = {"id": "W-24-1491", "ordered": "2024-12-30", "shipped": "2025-01-02",
                             "lines": [("B1", 2), ("K4", 2)], "ship": "locker"}

# --------------------------------------------------------------------------
# EU distance sales (consumers) - order level, both channels, in date order.
# channel "web" = own shop paid via Paytrail; "amazon" = Amazon.de (FBM,
# shipped from Oulu by the company itself).
# --------------------------------------------------------------------------

EU_ORDERS = [
    # December 2024
    {"id": "W-24-1352", "date": "2024-12-02", "ch": "web", "cc": "SE", "lines": [("K2", 2), ("K4", 3)]},
    {"id": "A-305-1184", "date": "2024-12-03", "ch": "amazon", "cc": "DE", "lines": [("B2", 1), ("K2", 1)]},
    {"id": "W-24-1358", "date": "2024-12-04", "ch": "web", "cc": "DE", "lines": [("G1", 1), ("K1", 2)]},
    {"id": "W-24-1361", "date": "2024-12-05", "ch": "web", "cc": "SE", "lines": [("B1", 1), ("K3", 2), ("M1", 1)]},
    {"id": "A-305-2210", "date": "2024-12-06", "ch": "amazon", "cc": "DE", "lines": [("K3", 3), ("M1", 1)]},
    {"id": "W-24-1366", "date": "2024-12-07", "ch": "web", "cc": "SE", "lines": [("G1", 2)]},
    {"id": "A-305-3391", "date": "2024-12-08", "ch": "amazon", "cc": "DE", "lines": [("B2", 2)]},
    {"id": "W-24-1371", "date": "2024-12-09", "ch": "web", "cc": "DE", "lines": [("K2", 3), ("J1", 1)]},
    {"id": "W-24-1374", "date": "2024-12-10", "ch": "web", "cc": "SE", "lines": [("K1", 4), ("B1", 1)]},
    {"id": "A-305-4078", "date": "2024-12-11", "ch": "amazon", "cc": "DE", "lines": [("K2", 2), ("K5", 2)]},
    {"id": "W-24-1383", "date": "2024-12-12", "ch": "web", "cc": "SE", "lines": [("G1", 1), ("K4", 2)]},
    {"id": "W-24-1389", "date": "2024-12-14", "ch": "web", "cc": "DE", "lines": [("B2", 1), ("M1", 2)]},
    {"id": "A-305-5520", "date": "2024-12-15", "ch": "amazon", "cc": "DE", "lines": [("K3", 2), ("K1", 2)]},
    {"id": "W-24-1397", "date": "2024-12-16", "ch": "web", "cc": "SE", "lines": [("K2", 2), ("K3", 1), ("J1", 2)]},
    {"id": "W-24-1401", "date": "2024-12-17", "ch": "web", "cc": "SE", "lines": [("B1", 1), ("K2", 1), ("M1", 1)]},
    {"id": "A-305-6607", "date": "2024-12-18", "ch": "amazon", "cc": "DE", "lines": [("B2", 1), ("M1", 1)]},
    {"id": "W-24-1409", "date": "2024-12-19", "ch": "web", "cc": "DE", "lines": [("G1", 1)]},
    {"id": "A-305-7713", "date": "2024-12-21", "ch": "amazon", "cc": "DE", "lines": [("K2", 3)]},
    {"id": "W-24-1433", "date": "2024-12-27", "ch": "web", "cc": "SE", "lines": [("K1", 2), ("K4", 2)]},
    {"id": "A-305-8840", "date": "2024-12-29", "ch": "amazon", "cc": "DE", "lines": [("K5", 3)]},
    # January 2025 (threshold exceeded in 2024 -> destination rules all year)
    {"id": "W-25-0011", "date": "2025-01-04", "ch": "web", "cc": "SE", "lines": [("B2", 1), ("K2", 1)]},
    {"id": "A-305-9012", "date": "2025-01-05", "ch": "amazon", "cc": "DE", "lines": [("K2", 2)]},
    {"id": "A-305-9107", "date": "2025-01-07", "ch": "amazon", "cc": "DE", "lines": [("K1", 4), ("B2", 1)]},
    {"id": "W-25-0019", "date": "2025-01-08", "ch": "web", "cc": "DE", "lines": [("K1", 3), ("J1", 2)]},
    {"id": "A-306-0144", "date": "2025-01-13", "ch": "amazon", "cc": "DE", "lines": [("B2", 1)]},
    {"id": "W-25-0034", "date": "2025-01-15", "ch": "web", "cc": "SE", "lines": [("G1", 1)]},
    {"id": "A-306-0391", "date": "2025-01-19", "ch": "amazon", "cc": "DE", "lines": [("K3", 4)]},
    {"id": "W-25-0047", "date": "2025-01-22", "ch": "web", "cc": "DE", "lines": [("M1", 2), ("K4", 2)]},
    {"id": "A-306-0588", "date": "2025-01-27", "ch": "amazon", "cc": "DE", "lines": [("K5", 2), ("M1", 1)]},
]
EU_CROSSING_ORDER = "W-24-1374"   # asserted by build.py: first order that takes the 2024 total over EUR 10,000

# Amazon.de fees and settlements
AMAZON = {
    "referral_pct": "15",
    "subscription": [("2024-12-01", "39.00"), ("2025-01-01", "39.00")],
    "ads": [("2024-12-10", "46.20"), ("2024-12-20", "38.75"), ("2025-01-09", "21.40"), ("2025-01-24", "17.85")],
    # (period start, period end, payout date). Opening receivable = the 17.-30.11. payout.
    "settlements": [("2024-12-01", "2024-12-14", "2024-12-17"), ("2024-12-15", "2024-12-28", "2024-12-31"),
                    ("2024-12-29", "2025-01-11", "2025-01-14"), ("2025-01-12", "2025-01-25", "2025-01-28")],
    "nov_payout": ("2024-12-03", "412.37"),
}

# --------------------------------------------------------------------------
# Payment providers
# --------------------------------------------------------------------------

PAYTRAIL = {
    "fee_pct": "1.49",
    "merchant_id": "695874",
    # settlement date -> covered period (inclusive)
    "settlements": [("2024-12-02", "2024-11-25", "2024-12-01"), ("2024-12-09", "2024-12-02", "2024-12-08"),
                    ("2024-12-16", "2024-12-09", "2024-12-15"), ("2024-12-23", "2024-12-16", "2024-12-22"),
                    ("2024-12-30", "2024-12-23", "2024-12-29"), ("2025-01-07", "2024-12-30", "2025-01-05"),
                    ("2025-01-13", "2025-01-06", "2025-01-12"), ("2025-01-20", "2025-01-13", "2025-01-19"),
                    ("2025-01-27", "2025-01-20", "2025-01-26")],
    "reserve": {"held_on": "2024-12-23", "amount": "1000.00", "released_on": "2025-01-20"},
    "chargeback": {"order": "W-24-1377", "order_date": "2024-12-12", "notified": "2025-01-16",
                   "lines": [("K2", 2), ("B2", 1)], "ship": "posti", "fee": "25.00"},
}

KLARNA = {
    "fee_pct": "2.99",
    "fixed_fee_per_order": "0.00",
    "merchant_id": "K-558120",
    "payouts": [("2024-12-05", "2024-11-25", "2024-12-01"), ("2024-12-12", "2024-12-02", "2024-12-08"),
                ("2024-12-19", "2024-12-09", "2024-12-15"), ("2024-12-27", "2024-12-16", "2024-12-22"),
                ("2025-01-02", "2024-12-23", "2024-12-29"), ("2025-01-09", "2024-12-30", "2025-01-05"),
                ("2025-01-16", "2025-01-06", "2025-01-12"), ("2025-01-23", "2025-01-13", "2025-01-19"),
                ("2025-01-30", "2025-01-20", "2025-01-26")],
}

# Oulu Christmas market stall 13.-22.12.2024: card terminal (Nexi) + MobilePay.
POPUP = {
    "name": "Oulun joulutori, koju 14",
    "days": ["2024-12-13", "2024-12-14", "2024-12-15", "2024-12-16", "2024-12-17", "2024-12-18",
             "2024-12-19", "2024-12-20", "2024-12-21", "2024-12-22"],
    "day_weights": [9, 14, 12, 6, 6, 7, 8, 11, 15, 12],
    "card_share_pct": [74, 71, 70, 76, 75, 73, 72, 72, 69, 70],
    "qty": {"K1": 92, "K2": 121, "K3": 64, "K4": 151, "K5": 30, "J1": 41, "B1": 22, "B2": 15, "M1": 45, "G1": 31},
    "nexi_fee_pct": "1.15",
    "mobilepay_fee_pct": "0.75",
    # payout date -> market days included
    "payouts": [("2024-12-16", ["2024-12-13", "2024-12-14", "2024-12-15"]), ("2024-12-17", ["2024-12-16"]),
                ("2024-12-18", ["2024-12-17"]), ("2024-12-19", ["2024-12-18"]), ("2024-12-20", ["2024-12-19"]),
                ("2024-12-23", ["2024-12-20", "2024-12-21", "2024-12-22"])],
}

# --------------------------------------------------------------------------
# Refunds, returns, B2B
# --------------------------------------------------------------------------

RETURNS = [
    # Domestic gift-box return under the 14-day right; December sale refunded in January
    # at the ORIGINAL (December) rates, refund netted into the 13.1. Paytrail settlement.
    {"id": "W-24-1402", "kind": "return", "order_date": "2024-12-18", "refund_date": "2025-01-08",
     "cc": "FI", "lines": [("G1", 1)], "ship": "posti", "refund_ship": True},
    # Swedish parcel lost in transit (post-threshold, OSS SE). Refunded in January;
    # the OSS correction belongs to Q4/2024 SE and is made in the next OSS return.
    {"id": "W-24-1401", "kind": "lost", "order_date": "2024-12-17", "refund_date": "2025-01-09",
     "cc": "SE", "lines": [("B1", 1), ("K2", 1), ("M1", 1)], "ship": "eu", "refund_ship": True},
]

B2B_INVOICE = {
    "no": "2024-118", "date": "2024-12-05", "delivery": "2024-12-05", "due": "2024-12-19",
    "ref": "241186", "boxes": 40, "giftcards": 20, "giftcard_value": "25.00", "freight_net": "39.00",
    "paid": "2025-01-02", "paid_message": "LASKU 118 JOULULAHJAT", "overpaid": "40.00",
    "refund_date": "2025-01-13",
}

# --------------------------------------------------------------------------
# Purchases
# --------------------------------------------------------------------------

PURCHASE_INVOICES = [
    {"key": "mt-1187", "sup": "makeistukku", "no": "M-24-1187", "date": "2024-12-03", "delivery": "2024-12-03",
     "due": "2024-12-17", "ref": "705127", "paid": "2024-12-17",
     "lines": [("Salmiakkisekoitus 500 g", 300, "2.85", "14", "candy"), ("Suklaalajitelma 400 g", 220, "5.40", "14", "candy"),
               ("Joulukalenteri maitosuklaa", 150, "4.60", "14", "candy"), ("Lakritsilahjapussi 250 g", 200, "2.10", "14", "candy"),
               ("Karpalolimonadi 4 x 0,33 l", 80, "3.20", "14", "drink"), ("Pantti, tölkit 320 x 0,15", 1, "48.00", "0", "deposit")]},
    {"key": "mt-1229", "sup": "makeistukku", "no": "M-24-1229", "date": "2024-12-18", "delivery": "2024-12-18",
     "due": "2025-01-17", "ref": "900427", "paid": "2025-01-17",
     "lines": [("Suklaalajitelma 400 g", 90, "5.40", "14", "candy"), ("Lakritsilahjapussi 250 g", 80, "2.10", "14", "candy"),
               ("Salmiakkisekoitus 500 g", 60, "2.85", "14", "candy")]},
    {"key": "mt-0042", "sup": "makeistukku", "no": "M-25-0042", "date": "2025-01-20", "delivery": "2025-01-20",
     "due": "2025-02-19", "ref": "1103003", "paid": None,
     "lines": [("Salmiakkisekoitus 500 g", 80, "2.85", "14", "candy"), ("Lakritsilahjapussi 250 g", 60, "2.10", "14", "candy"),
               ("Karpalolimonadi 4 x 0,33 l", 30, "3.20", "14", "drink"), ("Pantti, tölkit 120 x 0,15", 1, "18.00", "0", "deposit")]},
    # Invoice dated January for books DELIVERED 19.12.2024: 10 % is CORRECT (supply date).
    {"key": "ku-003", "sup": "kuusamo", "no": "K-2025-003", "date": "2025-01-02", "delivery": "2024-12-19",
     "due": "2025-01-22", "ref": "480028", "paid": "2025-01-22",
     "lines": [("Suomalaisen makeisen tarina (sid.)", 40, "11.20", "10", "book"), ("Karkkikeittiö - 60 reseptiä", 30, "13.10", "10", "book")]},
    # Invoice for books delivered 8.1.2025 still at 10 %: WRONG, should be 14 %.
    {"key": "ku-011", "sup": "kuusamo", "no": "K-2025-011", "date": "2025-01-10", "delivery": "2025-01-08",
     "due": "2025-02-07", "ref": "55217", "paid": None,
     "lines": [("Suomalaisen makeisen tarina (sid.)", 20, "11.20", "10", "book"), ("Karkkikeittiö - 60 reseptiä", 20, "13.10", "10", "book")]},
    # Packaging paid by Tuomas from his private account on 7.12. (company owes him)
    {"key": "pk-3391", "sup": "pakkaus", "no": "3391", "date": "2024-12-04", "delivery": "2024-12-04",
     "due": "2024-12-18", "ref": "33912", "paid": "private:tuomas:2024-12-07",
     "lines": [("Lahjalaatikko painettu, 30 x 20 x 10", 200, "1.35", "25.5", "packaging"),
               ("Silkkipaperi, 500 arkkia", 4, "18.90", "25.5", "packaging"),
               ("Pakkausteippi 66 m, logo", 24, "3.40", "25.5", "packaging")]},
    {"key": "lk-1224", "sup": "lokerikko", "no": "LK-241231-0877", "date": "2024-12-31", "delivery": "2024-12-31",
     "due": "2025-01-14", "ref": "20250115", "paid": "2025-01-14",
     "lines": [("Pakettiautomaattilähetykset 12/2024", 152, "3.60", "25.5", "freight"),
               ("Palautuslähetykset", 4, "3.60", "25.5", "freight")]},
    {"key": "lk-0131", "sup": "lokerikko", "no": "LK-250131-0911", "date": "2025-01-31", "delivery": "2025-01-31",
     "due": "2025-02-14", "ref": "20250131", "paid": None,
     "lines": [("Pakettiautomaattilähetykset 01/2025", 63, "3.60", "25.5", "freight"),
               ("Palautuslähetykset", 2, "3.60", "25.5", "freight")]},
]

# Posti monthly invoice for DECEMBER shipments, dated 3.1.2025 (accrue to December).
POSTI_DEC = {"no": "3004188712", "date": "2025-01-03", "period": "1.12.-31.12.2024", "due": "2025-01-17",
             "ref": "20250115", "paid": "2025-01-17",
             "lines": [("Postipaketti, kotimaa", 214 + 40, "5.20"), ("Pikkupaketti, EU (SE/DE)", 12, "11.80"),
                       ("Postipaketti, EU (SE/DE)", 8, "14.60"), ("Lisämaksu: ylisuuri lähetys", 3, "8.00")],
             "fuel_pct": "4.5"}
# Posti credit note: the lost Swedish parcel of W-24-1401.
POSTI_CREDIT = {"no": "3004201355", "date": "2025-01-20", "ref_invoice": "3004188712",
                "freight": "14.60", "fuel_pct": "4.5", "compensation": "58.00", "tracking": "JJFI64112233440012345"}

# Imports
UK_IMPORT = {
    "invoice": {"no": "TT-5521", "date": "2024-12-02", "incoterm": "EXW Sheffield", "currency": "GBP",
                "lines": [("Cream toffee 200 g, retail pack (HS 1704 90)", 900, "2.40"),
                          ("Export packing, 2 pallets", 1, "38.00")],
                "origin_statement": "The exporter of the products covered by this document (Exporter Reference No GB918441127000) "
                                    "declares that, except where otherwise clearly indicated, these products are of UK preferential origin.",
                "due": "2024-12-16"},
    "ecb_rate_invoice": "0.83012",   # GBP per EUR on invoice date (synthetic)
    "bank_paid": "2024-12-16", "bank_rate": "0.82650", "bank_fee": "9.00",
    "customs": {"date": "2024-12-10", "mrn": "24FI000000123456T7", "customs_rate": "0.82940",
                "freight_to_border": "310.00", "freight_inland": "110.00", "duty_pct": "0"},
    "forwarder": {"no": "PH-24-3318", "date": "2024-12-11", "due": "2024-12-20", "ref": "1103016", "paid": "2024-12-20",
                  "freight": "420.00", "clearance_fee": "48.00"},
}
CHINA_IMPORT = {
    "invoice": {"no": "HF-24-1107", "date": "2024-12-10", "incoterm": "FOB Ningbo", "currency": "USD",
                "lines": [("Stoneware mug 300 ml, 'Karkkiaitta' print", 600, "3.00")], "shipped": "2024-12-10",
                "bl": "NGBOUL24121088"},
    "advance_usd": "540.00", "advance_eur": "503.26",     # paid 18.11.2024 (opening 1790)
    "balance_usd": "1260.00", "ecb_rate_invoice": "1.0556", "bank_paid": "2024-12-12", "bank_rate": "1.0498", "bank_fee": "12.00",
    "customs": {"date": "2025-01-08", "mrn": "25FI000000004411K2", "customs_rate": "1.0342",
                "freight_to_border": "590.00", "freight_inland": "95.00", "duty_pct": "9.0"},
    "forwarder": {"no": "PH-25-0042", "date": "2025-01-10", "due": "2025-01-20", "ref": "1103016", "paid": "2025-01-20",
                  "freight": "685.00", "clearance_fee": "48.00"},
}

# Company credit card (Merituuli Business Mastercard), billed per calendar month, debited on the 10th.
CARD = {
    "last4": "7731",
    "nov_invoice_total": "1184.62",
    "txns": [
        # date, merchant, description, eur, (orig currency, orig amount), kind
        ("2024-12-01", "SHOPIFY* 312550148", "Shopify Basic + apps 12/2024", "103.56", ("USD", "108.00"), "shopify"),
        ("2024-12-02", "SHOPIFY* 312550149", "Shopify transaction fees 11/2024", "203.83", ("USD", "212.60"), "shopify"),
        ("2024-12-03", "MAILCHIMP *MONTHLY", "Mailchimp Standard", "43.16", ("USD", "45.00"), "mailchimp"),
        ("2024-12-01", "KIRJURI PILVI OY", "Kirjanpito-ohjelmisto 12/2024", "48.95", None, "kirjuri"),
        ("2024-12-04", "FACEBK *ADS 4YH2K", "Meta ads", "300.00", None, "meta"),
        ("2024-12-11", "K-RAUTA OULU LIMINGANTULLI", "Pakkauspöytä + hyllykkö", "189.00", None, "krauta"),
        ("2024-12-12", "FACEBK *ADS 9JQ7M", "Meta ads", "300.00", None, "meta"),
        ("2024-12-13", "TOKMANNI OULU KAAKKURI", "Pakkaustarvikkeet", "34.80", None, "tokmanni"),
        ("2024-12-15", "GOOGLE *ADS8873211", "Google Ads", "250.00", None, "google"),
        ("2024-12-19", "FACEBK *ADS 2PL6X", "Meta ads", "300.00", None, "meta"),
        ("2024-12-31", "FACEBK *ADS 7TT1D", "Meta ads", "142.18", None, "meta"),
        ("2024-12-31", "GOOGLE *ADS8873211", "Google Ads", "186.40", None, "google"),
        ("2025-01-01", "SHOPIFY* 318800312", "Shopify Basic + apps 01/2025", "104.25", ("USD", "108.00"), "shopify"),
        ("2025-01-02", "SHOPIFY* 318800313", "Shopify transaction fees 12/2024", "343.92", ("USD", "356.40"), "shopify"),
        ("2025-01-03", "MAILCHIMP *MONTHLY", "Mailchimp Standard", "43.49", ("USD", "45.00"), "mailchimp"),
        ("2025-01-01", "KIRJURI PILVI OY", "Kirjanpito-ohjelmisto 01/2025", "48.95", None, "kirjuri"),
        ("2025-01-09", "FACEBK *ADS 1MM3C", "Meta ads", "200.00", None, "meta"),
        ("2025-01-12", "AMAZON.DE*R42KL77", "Amazon.de order 304-5518812", "84.99", None, "private"),
        ("2025-01-28", "FACEBK *ADS 6QW8N", "Meta ads", "164.35", None, "meta"),
        ("2025-01-31", "GOOGLE *ADS8873211", "Google Ads", "142.10", None, "google"),
    ],
}
KRAUTA_RECEIPT = [("Pakkauspöytä 160 x 80 säädettävä", "1", "149.00"), ("Seinähyllykkö 3-os.", "1", "40.00")]
TOKMANNI_RECEIPT = [("Pakkausteippi 3 kpl", "2", "6.95"), ("Kuplamuovi 10 m", "2", "8.45"), ("Merkkauskynä 4 kpl", "1", "4.00")]

# Personnel / insurance
PAYSLIPS = [
    # payment date, work period, normal hours, evening hours, sunday hours
    {"key": "P1", "paid": "2024-12-10", "period": ["2024-11-25", "2024-11-30"], "hours": 26, "evening": 6, "sunday": 0},
    {"key": "P2", "paid": "2025-01-10", "period": ["2024-12-01", "2024-12-31"], "hours": 100, "evening": 22, "sunday": 12},
    {"key": "P3", "paid": "2025-02-07", "period": ["2025-01-01", "2025-01-31"], "hours": 48, "evening": 6, "sunday": 0,
     "final": True},
]
ACCIDENT_INSURANCE = {"no": "RV-2412-55810", "date": "2024-12-16", "due": "2025-01-15", "ref": "24121651",
                      "period": "1.1.-31.12.2025", "estimated_payroll": "12000.00", "min_premium": "140.00"}

# YEL: December invoices for both founders. Liisa's was paid from the COMPANY account
# by mistake (5.12.) and she repaid it (19.12.). Tuomas paid his own privately.
YEL_INVOICES = [{"founder": "liisa", "no": "Y-2412-771045", "date": "2024-11-25", "due": "2024-12-05", "ref": "7710458",
                 "paid_by": "company", "repaid": "2024-12-19"},
                {"founder": "tuomas", "no": "Y-2412-771046", "date": "2024-11-25", "due": "2024-12-05", "ref": "7710461",
                 "paid_by": "private"}]

# Tax account (OmaVero). Company's personal reference for self-assessed taxes; OSS reference separate.
TAX = {
    "ref": "7710018",
    "oss_ref": "RF09OSS2410458",
    "oct_vat_paid": "2024-12-20",     # due 12.12.2024 -> 8 days late
    "combined_paid": "2025-01-13",
    "oss_paid": "2025-01-31",
    "oss_registered": "2024-12-18",
}

# Opening balances 30.11.2024 (the previous accountant's trial balance). The
# payroll and platform receivables are derived by build.py and must match.
OPENING = {
    "1500": "21480.00", "1790": "503.26", "1910": "18432.17",
    "2890_makeistukku_nov": "4212.80", "2890_posti_nov": "612.30",
    "2941_oct": "2184.60", "2941_nov": "3102.45",
    "2000": "2500.00",
}

# Inventory count 31.12.2024 (physical, at cost excl. VAT) and destroyed goods.
STOCK_COUNT = [
    ("K1", 820), ("K2", 610), ("K3", 38), ("K4", 700), ("K5", 806), ("J1", 240),
    ("B1", 300), ("B2", 240), ("M1", 800), ("BOX_EMPTY", 146),
]
STOCK_EXTRA_COST = {"BOX_EMPTY": ("Lahjalaatikko tyhjä (painettu), ei myyntituote", "1.35")}
DESTROYED = {"date": "2024-12-30", "lines": [("K1", 64, "Parasta ennen 11/2024 - hävitetty"), ("K3", 22, "Joulukalenteri, rikkoutunut pakkaus")]}

# Bank monthly fees
BANK_FEES = [("2024-12-31", "Palvelumaksut 12/2024", "14.90"), ("2025-01-31", "Palvelumaksut 01/2025", "14.90")]

# Tuomas: company owes him the packaging invoice; he owes the company the private
# Amazon purchase; the company pays the NET on 31.1.
TUOMAS_NET_PAID = "2025-01-31"

# The web shop's tax setting for books was still 10 % until the owner changed it
# on 9.1.2025. The Shopify-style January report therefore shows 10 % tax on the
# books (and gift-box book shares) shipped 1.-8.1. The gross prices were right;
# the VAT due is 14 % on every book supplied in January. These quantities are
# part of WEB_BULK["2025-01"], not in addition to it.
WEB_TAX_SETTING_FIX = {"date": "2025-01-09", "before_qty": {"B1": 5, "B2": 4, "G1": 3}}
