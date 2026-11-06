# Synthetic Finnish test pack: Karkkiaitta Oy, December 2024 – January 2025

**SYNTEETTINEN TESTIAINEISTO.** Everything here is fictional: the company, the
people, the identifiers, the accounts and the transactions. Large platforms
(Shopify, Paytrail, Klarna, Nexi, MobilePay, Amazon, Meta, Google, Mailchimp,
Posti, K-Rauta, Tokmanni), public bodies (Verohallinto, Tulli, Työllisyysrahasto)
and a pension insurer (Elo) appear by name only, the same way they do in the
Kultalanka pack. No real business ID is printed for a real company.

This pack is harder than `fi-kultalanka-2025-02`: two months instead of one,
an accrual (suoriteperuste) e-commerce company, the 1.1.2025 VAT-rate change,
OSS, a marketplace, two imports, five payment rails and payroll across the year
boundary. It has **sources and an answer key only**. There is no `labels.json`
and nothing is wired into `scripts/fi_kultalanka_eval.js` yet; that waits for
Kari's review.

## Company profile

| | |
| --- | --- |
| Company | Karkkiaitta Oy, Oulu. Y-tunnus 3409812-2, VAT FI34098122 |
| Business | Online shop for Finnish candy, chocolate advent calendars, gift boxes, soft drinks, two books and a branded mug. Own web shop (Shopify-style), Amazon.de (fulfilled by the merchant from Oulu) and a Christmas-market stall |
| Owners | Liisa Kärkkäinen (CEO, 50 %) and Tuomas Rautio (chair, 50 %). Both are YEL-insured and pay YEL themselves. Neither draws a salary |
| Staff | Veera Nieminen, a part-time packer on a fixed-term contract (25.11.2024–31.1.2025), paid by the hour with evening and Sunday supplements |
| Books | Accrual basis, calendar financial year, monthly VAT period, bank Merituuli Pankki (fictional), IBAN FI12 7911 2000 4580 25 |
| Opening position | Trial balance at 30.11.2024 from the previous accountant (document 03) |

## Files

`sources/` holds 65 files: 63 PDFs and 2 JPEG photos. File names follow the
Kultalanka numbering:

- `01–05` bank statements (12/2024, 01/2025), the opening trial balance, the company-card invoices
- `10–29` sales: web-shop reports (English), the EU distance-sales export, Paytrail (with a reserve e-mail), Klarna (English), Nexi and MobilePay, the market-stall Z report, Amazon.de settlements (**German** for December, English for January), Amazon fee invoices, the B2B invoice and e-mail thread, the gift-card report, a return form and a **Swedish** complaint e-mail
- `30–54` purchases: candy wholesaler, book publisher, packaging (paid by a founder), parcel lockers, Posti invoice and credit note, UK and China imports with customs decisions and forwarder invoices, Shopify, Mailchimp, Meta, Google, accounting software, two photographed receipts, and a founder's private Amazon order
- `60–71` payroll and taxes: three payslips, an hours report, the Incomes Register summary, TyEL, both YEL invoices, the unemployment-insurance invoice, statutory accident insurance, the OmaVero tax-account statement and the OSS return
- `80–81` stock count at 31.12.2024 and the destruction record
- `90 Kirjausohje ja vastaukset - Karkkiaitta Oy 12-2024-01-2025.pdf`: the answer key, laid out like Kultalanka's. Section A has the rules and traps, section B has every bank line's booking (B1) plus every document-based entry with no bank line (B2), and section C has the monthly figures (VAT return fields, OSS, deductions, payroll, inventory, bank reconciliation, P&L and balance-sheet balances)

`SHA256SUMS` lists the hash of every file.

## Regenerating

The pack is produced by `scripts/fixtures/fi_synthetic_karkkiaitta/` from one
data file (`data.py`: literals only). The rest of the package derives the numbers
(`model.py`), checks them (`check_model`), and renders the source documents
(`documents.py`) and the answer key (`answerkey.py`).

```bash
python3 -m venv .venv-fixtures
.venv-fixtures/bin/pip install -r scripts/fixtures/fi_synthetic_karkkiaitta/requirements.txt
.venv-fixtures/bin/python scripts/fixtures/fi_synthetic_karkkiaitta/build.py            # rebuild sources/ + SHA256SUMS
.venv-fixtures/bin/python scripts/fixtures/fi_synthetic_karkkiaitta/build.py --verify   # rebuild to a temp dir, compare byte-for-byte
```

The build writes nothing if any check fails. The checker verifies:

- every journal entry balances, and every VAT line's tax matches its base and rate
- both bank statements run from the opening balance to the closing balance to the cent, every bank line has exactly one booking, and GL 1910 equals the statement
- the Y-tunnus check digit on every Finnish business ID, the mod-97 checksum and domestic check digit on every FI IBAN, and the check digit on every Finnish and RF reference number
- every payout reconciles to its report: Paytrail gross − fee − refunds − chargeback − reserve = paid
- every payslip adds up, and the payroll liabilities at 31.1. equal what the next payslip and tax dates imply
- web-shop gross equals Paytrail + Klarna + gift cards, and every purchase invoice's net + VAT = gross
- the clearing accounts that must empty (reserve, shareholder receivable and payable, overpayment, advances, B2B receivable, Nexi, MobilePay) are zero at 31.1., and the platform receivables equal the unsettled tails
- the VAT accounts are closed every month, 2941 equals December + January VAT due, and the OSS liability equals the January OSS tax
- the closing trial balance balances, and no bank line falls on a weekend or a bank holiday
- which EU order actually crosses the EUR 10,000 threshold (asserted against the data file)

The output is byte-identical with the pinned versions (ReportLab 4.2.5,
Pillow 11.0.0, PyMuPDF 1.28.2): only the standard PDF fonts are used, ReportLab
runs in invariant mode, and the photo noise is seeded.

## Trap list

Bank lines are referred to by date and counterparty. "B1" and "B2" are the answer key's sections.

| # | Trap | Where | Correct outcome |
| --- | --- | --- | --- |
| 1 | Candy and soft drinks did **not** move to 25.5 % on 1.1.2025 | 32 (M-25-0042 at 14 %) | 14 % is right; do not "correct" it. Only books changed (10 % → 14 %) |
| 2 | January-dated invoice for books delivered in December | 33 (K-2025-003) | 10 % is right. Book it as a December purchase with December's deduction |
| 3 | Supplier still at 10 % after 1.1. | 34 (K-2025-011, delivered 8.1.) | Should be 14 %. Deduct only the 10 % shown and ask for a corrected invoice |
| 4 | Web-shop tax setting still at 10 % for books until 9.1. | 11 | The report's VAT on books is wrong for 1–8 Jan. VAT is 14 % of the gross (key A3 gives the difference) |
| 5 | Paid in December, shipped in January (Paytrail) | 10, 11, 13 | This is an advance payment. VAT is due in December at the rate when paid (books 10 %), booked to 2880. Revenue is recognised on delivery in January with no new VAT |
| 6 | Ordered 30.12., captured by Klarna on shipment 2.1. | 10, 11, 17 | No advance was received, so this is a January sale and the book is at 14 % |
| 7 | Mixed gift box (chocolate + book + mug) | 10, 11, 20, 25 | Split the price by component cost: 14 % / 10 % (2024) or 14 % (2025) / 25.5 % |
| 8 | Shipping charged to customers | 10, 11, 25 | Shipping follows the goods, split across rates by the goods' net value |
| 9 | January return of a December sale | 28, 14 | Refund at December rates, so January has a negative 10 % line |
| 10 | Chargeback deducted from a later payout | 14 (20.1. settlement) | Credit loss with VAT reduction at the original rates, and the fee is an expense |
| 11 | Payout ≠ report because of a reserve | 13, 15, bank 23.12. and 20.1. | EUR 1,000 goes to 1720 Paytrail reserve and is released 20.1. |
| 12 | Batched net payouts, weekends combined into one line | 13, 14, 16–19, bank | Book sales from the reports and let settlements clear the clearing accounts. Fees are exempt financial services |
| 13 | Opening receivables settle in December | 03, bank 2.12./3.12./5.12. | They clear 1710/1711/1712. They are not new sales |
| 14 | EUR 10,000 EU threshold crossed on 10.12. (order W-24-1374) | 12 | The crossing order is already taxed in the destination country. Earlier December EU orders carry Finnish VAT (3060). From then on, and for all of 2025, SE/DE rates apply via OSS. The store kept charging Finnish VAT until 18.12. |
| 15 | OSS is separate from the Finnish return | 71, bank 31.1. | Q4 OSS VAT of EUR 68.92 is paid 31.1. with its own RF reference. OSS sales are not in the kausiveroilmoitus |
| 16 | Lost Swedish parcel | 29, 40, 14 | The OSS SE sale is reversed in January (correction to Q4 SE in the next OSS return). On the Posti credit, the freight credit reduces input VAT, while the content compensation is damages outside VAT (3990) |
| 17 | Amazon.de marketplace (seller established in the EU, fulfilled by merchant) | 21–24 | The company is the supplier, not Amazon. Payouts are net of fees, and the settlement periods cross month-end. The Luxembourg fee invoices are reverse charge (EU services) |
| 18 | UK import after Brexit | 41–43, bank 16.12., 20.12. | FX difference on payment. Duty 0 % (TCA origin statement). Import VAT 14 % self-assessed in December (output = deduction). Forwarder freight 0 %, clearance fee 25.5 % |
| 19 | China import under FOB | 44–46, 80 | Risk passed 10.12., so it is a December purchase. The in-transit goods are **added** to 31.12. inventory although not counted. Duty 9 % is passed through without VAT. Import VAT 25.5 % falls in **January** (the customs month) |
| 20 | Reverse charge: EU vs non-EU services | 04, 05, 47–50 | Meta, Google, Shopify and Amazon go in "palveluostot muista EU-maista". Mailchimp (US) goes in the domestic 25.5 % field. All are deductible |
| 21 | Founder's YEL paid from the company account | 66, bank 5.12., 19.12. | Receivable from the shareholder (1795), repaid. Tuomas's YEL (67) was paid privately, so there is no booking |
| 22 | Founder paid a supplier privately, and a private purchase on the company card | 35, 36, 54, 05, bank 31.1. | Company owes Tuomas EUR 536.14. He owes EUR 84.99. The net EUR 451.15 is paid 31.1. |
| 23 | December wages paid in January | 61, 63, 64 | Use the 2025 tax card and 2025 contribution rates (sava 1.87 %). Accrue to December |
| 24 | Holiday compensation for a part-timer | 62 | 9 % percentage-based. Accrue monthly with side costs and pay in the final salary 7.2. |
| 25 | One OmaVero payment for four tax types, plus late interest | 70, bank 13.1. | Split ALV 11/2024, withholding, sava and late interest EUR 5.51 (the October VAT was paid 8 days late) |
| 26 | Invoices for one period dated in the next | 39 (Posti 3.1.), 69 (insurance for 2025) | Posti is a December expense. The insurance is prepaid (1780), 1/12 per month |
| 27 | B2B customer paid late, with the wrong reference and EUR 40 too much | 25, 26, bank 2.1., 13.1. | Match by customer and amount. The overpayment goes to 2881 and is refunded |
| 28 | Gift cards are multi-purpose vouchers | 27, 25 | No VAT at sale (2878). VAT at redemption at the rate then in force |
| 29 | Stock count, shrinkage, expired candy | 80, 81 | Inventory change = count + in-transit − opening. Destroyed goods need no VAT correction. No count in January, so no January change |
| 30 | Smaller items | 30–32, 52, 53 | Can deposits are outside VAT. The packing table is a small acquisition. Both photographed receipts are on the card invoice |

## Deviations from the brief (deliberate, with reasons)

1. **Candy and soft drinks stay at 14 % in January 2025.** The brief assumed
   they moved to 25.5 % on 1.1.2025. That increase was planned for 1.6.2025 and
   then dropped by the government, and it never took effect. Only the 10 % items
   (books among them) moved to 14 % on 1.1.2025. Per the "never trim / record
   from primary source" rail, the pack follows the law as it was, and the brief's
   premise is itself a trap (trap 1). The rate-change texture comes from the
   books instead: the rate is decided by the supply date, or by the payment date
   for advances (trap 5).
2. **The supply-date rule has an advance-payment exception.** Orders prepaid in
   December are taxed at the December rate even though they are delivered in
   January. The pack includes both sides (traps 5 and 6).
3. **No FBA storage fees.** Stock held in a German Amazon warehouse would make
   Karkkiaitta liable to register for German VAT, and moving the stock there
   would be an intra-Community transfer of own goods. That is out of scope for a
   bookkeeping test and would be wrong to fake. The marketplace is therefore
   fulfilled by the merchant from Oulu, and the texture comes from referral
   fees, the subscription, advertising and settlement periods that cross
   month-end.
4. **Holiday compensation** uses the percentage method (9 % of wages). The
   contract is under 14 days a month, and the December hours report was built
   with 13 shifts of at most 8 hours so that the facts support this.

## Where Finnish practice allows two treatments (the key states its choice)

- The Paytrail advance date: the customer's payment date (key) or Paytrail's settlement date.
- The gift-box split: purchase cost (key) or relative selling prices.
- Paytrail, Nexi, Klarna and Amazon: clearing accounts with sales from reports (key), or gross per payout.
- The chargeback: a final credit loss now (key), or a receivable until the loss is final.
- The late-payment interest: booked when it shows on the tax account (key, January), or accrued to December.
- The reverse-charge base in a foreign currency: the card-charged EUR (key), or the ECB rate.
- YEL paid by the company: a receivable from the owner (key, and repaid), or the owner's taxable salary.
- January inventory: no change without a count (key), or an estimated change.
- Payroll: accrued monthly including holiday compensation and side costs (key), or booked on payment with a year-end accrual.

## Sources and statutory numbers

**Verification limit.** vero.fi, finlex.fi, tulli.fi, tyollisyysrahasto.fi,
elo.fi, skatteverket.se and the EU sites were **blocked by this cloud session's
network policy**. Numbers were checked through web-search result summaries that
cite the pages below, not by reading the primary pages. Everything marked
UNVERIFIED rests on memory or on an ambiguous summary and should be checked
before the pack is used for scoring. As-of date of the checks: **2026-09-24**.

| Number / rule | Value used | Source (as cited) | Status |
| --- | --- | --- | --- |
| FI general VAT rate | 25.5 % since 1.9.2024 | vero.fi, "Yleinen arvonlisäverokanta nousee syyskuussa" press release (2024) | verified via search summary |
| Books 10 % → 14 % from 1.1.2025; supply date decides; advances at the rate when paid; credit notes at the original rate | as stated | vero.fi "Kirjojen ja lehtien arvonlisäverotus"; Greenstep, Rantalainen, Talenom and KPMG articles on the 2025 changes | verified via search summary |
| Candy/chocolate increase to 25.5 % dropped (never in force) | 14 % throughout | vm.fi "Makeisten arvonlisäverotus ei kiristy"; Kehittyvä Elintarvike "Makeisten ja suklaan arvonlisäveron korotus kaatui" | verified via search summary |
| Soft drinks: no VAT change (only the soft-drink excise rose) | 14 % | Taloustaito.fi 2025 changes article | verified via search summary |
| Chocolate advent calendar = confectionery, not a book | 14 % | — | UNVERIFIED (reasoned from the product's nature) |
| Multi-purpose vouchers: no VAT at sale, VAT on redemption (since 1.1.2019) | as stated | vero.fi "Arvoseteleiden arvonlisäverotuksesta"; Kauppa.fi (2018) | verified via search summary |
| Shipping and other charges split by goods' net value per rate | as stated | vero.fi "Arvonlisäverovelvollisen opas" | verified via search summary |
| EUR 10,000 EU threshold; destination rules from the crossing supply and for the following year | as stated | vero.fi "Tavaroiden etämyynnin arvonlisäverotus"; EU OSS guidelines (vat-one-stop-shop.ec.europa.eu) | verified via search summary |
| OSS registration effective from the first supply if notified by the 10th of the following month | as stated | EU OSS guidance (Art. 57d of Implementing Regulation 282/2011) | UNVERIFIED |
| OSS return quarterly, due end of the following month (Q4 → 31.1.) | 31.1.2025 | vero.fi OSS returns page | verified via search summary |
| Sweden: standard 25 %, food and soft drinks 12 %, books 6 % (Dec 2024–Jan 2025; food to 6 % only from 1.4.2026) | as stated | Skatteverket VAT rates page; PwC tax summaries | verified via search summary, **except** candy at 12 %, which is UNVERIFIED (one summary suggested some candy may be 25 %) |
| Germany: 19 % standard, 7 % food incl. confectionery and books, soft drinks 19 % | as stated | vatupdate.com, Stripe and Wise guides citing UStG Anlage 2 | verified via search summary |
| Import VAT self-assessed on the periodic return by VAT-registered importers (since 2018); base = customs value + duty + transport to destination | as stated | vero.fi "Maahantuonnin arvonlisäveron peruste"; tulli.fi import VAT page | verified via search summary |
| Import transport exempt when included in the import VAT base | "AVL 71 §" | — | paragraph number UNVERIFIED |
| EU–UK TCA preferential duty with a statement on origin | 0 % | — | UNVERIFIED (well known; tariff line 1704 90 75 not checked) |
| Duty on stoneware mugs (6912 00 50) | 9.0 % | synthetic customs decision | UNVERIFIED, a synthetic figure |
| Non-EU service reverse charge reported in "vero kotimaan myynnistä" | 25.5 % field | Netvisor support; Kitsas docs; Verohallinnon ohje via Edilex | verified via search summary |
| Credit-loss VAT correction | AVL 78 § | — | UNVERIFIED paragraph reference |
| Payment-processing fees VAT-exempt financial services | AVL 41 § | as in the Kultalanka key | UNVERIFIED paragraph reference |
| TyEL 2024: average 24.81 %, employee 7.15 % (17–52) | employer 17.66 % (= 24.81 − 7.15) | Ilmarinen 2024 contributions release; veronmaksajat.fi | verified via search summary (employer share is an average; an insurer's small-employer rate can differ) |
| TyEL 2025: average 24.85 %, employee 7.15 % | employer 17.70 % | veronmaksajat.fi "Eläkevakuutusmaksut 2025"; Elo | verified via search summary |
| YEL 2024 (and 2025) | 24.10 % (under 53) | veronmaksajat.fi; Elo | verified via search summary |
| Unemployment insurance 2024 | employee 0.79 %, employer 0.27 % (≤ EUR 2,337,000) | tyollisyysrahasto.fi "Vuoden 2024 työttömyysvakuutusmaksut on vahvistettu"; veronmaksajat.fi | verified via search summary |
| Unemployment insurance 2025 | employee 0.59 %, employer 0.20 % (≤ EUR 2,455,500) | tyollisyysrahasto.fi "Vuoden 2025 työttömyysvakuutusmaksut on vahvistettu" | verified via search summary |
| Employer health insurance (sava) | 2024 1.16 %, 2025 1.87 % | veronmaksajat.fi "Työnantajamaksut 2026–2021"; EK memo 16.12.2024 | verified via search summary |
| Withholding and sava due on the 12th of the month after payment; Incomes Register report within 5 days | as stated | vero.fi employer pages | UNVERIFIED (standard practice, not re-read) |
| Tax late-payment interest 2024 (reference rate + 7 pp) | 11.5 % | vero.fi "Peruskorko ja viitekorko verotuksessa" (formula only) | rate UNVERIFIED |
| Statutory accident insurance exempt from insurance premium tax | as stated | — | UNVERIFIED |
| Holiday compensation for employment < 1 year, under 14 days a month by contract | 9 % | vuosilomalaki | UNVERIFIED paragraph (12 § / 16 §) |
| Sunday work +100 % | as stated | työaikalaki | UNVERIFIED paragraph |
| Evening supplement 20 % | contractual | the (synthetic) employment contract | synthetic |
| Accident insurance premium rate 0.92 %, minimum EUR 140 | contractual | synthetic insurer | synthetic |
| Exchange rates (ECB, bank, Tulli, card) | as printed | — | synthetic, not real fixings |

## Trust-the-strong-LLM principle — still in force

See `CLAUDE.md` and `docs/donna-llm-trust-strategy.md`. This pack is built to
test whether the strong model reads these documents the way a careful Finnish
bookkeeper would. It adds no rules that substitute for the model's judgement.
