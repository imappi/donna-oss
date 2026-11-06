"""Renders the answer key ("90 Kirjausohje ja vastaukset ...") from the Model.

Section A is prose with numbers pulled from the model; sections B and C are
generated from the journal, so the key cannot disagree with itself.
"""

from __future__ import annotations

from collections import defaultdict

from . import data as D
from .layout import GREY, Doc, colors, fdate, fi, mm
from .model import ACCOUNTS, ZERO, balances, m, month_of, pct

CO = D.COMPANY


def acct_line(l):
    amt = l.debit or l.credit
    name = ACCOUNTS[l.acct]
    s = f"{l.acct} {name} {fi(amt)}"
    if l.tag:
        t = l.tag
        if t[0] == "sale":
            s += f" [myynti {t[1].replace('.', ',')} %]"
        elif t[0] == "oss":
            s += f" [OSS {t[1]} {t[2].replace('.', ',')} %]"
        elif t[0] == "rc_eu_serv":
            s += " [EU-palveluosto]"
        elif t[0] == "rc_noneu":
            s += " [EU:n ulkop. palvelu]"
        elif t[0] == "import":
            s += f" [maahantuonti {t[1].replace('.', ',')} %]"
        elif t[0] == "input":
            s += ""
    return s


def entry_row(e, with_amount=True):
    deb = "\n".join(acct_line(l) for l in e.lines if l.debit)
    cre = "\n".join(acct_line(l) for l in e.lines if l.credit)
    if e.bank:
        what = f"{e.bank.party.title()} {fi(e.bank.amount, plus=True)}\n{e.text}"
    else:
        what = e.text
    return [fdate(e.date)[:6], what, deb, cre, e.note or ""]


def section_a(M):
    d = M.docs
    P = d["payslips"]
    inv = d["inventory"]
    ukd, cnd = d["uk"], d["cn"]
    pts = next(s for s in d["paytrail_settlements"] if s["reserve"])
    li = d["late_interest"]
    cp = d["combined_payment"]
    cross = next(e for e in d["eu_orders"] if e["order"]["id"] == D.EU_CROSSING_ORDER)
    fix = D.WEB_TAX_SETTING_FIX
    web_jan = d["web"]["2025-01"]["priced"]
    # the store's wrong January book tax vs the correct 14 %
    wrong = ZERO
    right = ZERO
    for r in web_jan["rows"]:
        if r["cat"] == "book" and r["product"] in fix["before_qty"]:
            unit = r["gross"] / r["qty"]
            g_b = m(unit * fix["before_qty"][r["product"]])
            from .model import vat_from_gross
            wrong += vat_from_gross(g_b, "10")
            right += vat_from_gross(g_b, "14")
    t = d["tuomas_net"]
    items = [
        ("Makeiset ja virvoitusjuomat pysyivät 14 %:ssa 1.1.2025",
         "Makeisten, suklaan ja virvoitusjuomien siirto 25,5 %:iin peruttiin (hallitus luopui korotuksesta; ks. README). "
         "Vuodenvaihteessa muuttui vain kirjojen verokanta 10 % -> 14 %. Makeistukun tammikuun lasku M-25-0042 "
         "(14 %) on OIKEIN – sitä ei saa \"korjata\" 25,5 %:iin. Joulukalenteri (K3) on suklaata, ei kirja eikä paperikalenteri."),
        ("Kirjojen verokanta ratkeaa toimituspäivästä (tai ennakkomaksun maksupäivästä)",
         "Kustannus Kuusamon lasku K-2025-003 on päivätty 2.1.2025, mutta kirjat toimitettiin 19.12.2024: 10 % on oikein, "
         "ja osto ja ALV-vähennys kuuluvat joulukuulle (inventaariossa kirjat ovat jo mukana). Lasku K-2025-011 koskee "
         "8.1.2025 toimitettuja kirjoja, mutta siinä on yhä 10 %: oikea kanta on 14 %. Vähennetään vain laskulla oleva "
         "vero (10 %) ja pyydetään toimittajalta hyvitys + uusi lasku; lisävähennys vasta oikaistulla laskulla."),
        ("Verkkokaupan tammikuun raportti laskee kirjoille väärän veron 1.–8.1.",
         f"Kaupan veroasetus oli kirjoilla 10 % {fdate(fix['date'])} asti. Myyntihinnat olivat oikeat, mutta raportin "
         f"ALV-sarake on näiltä riveiltä väärin: raportti {fi(wrong)} €, oikein 14 %:lla {fi(right)} € "
         f"(ero {fi(right - wrong)} €). Tammikuun myynnin ALV lasketaan bruttohinnoista 14 %:lla."),
        ("Ennakkomaksut: joulukuussa maksetut, tammikuussa toimitetut tilaukset",
         "Tilaukset " + ", ".join(a["order"]["id"] for a in d["advance"]) + " maksettiin Paytrailin kautta 29.–31.12. ja "
         "toimitettiin 2.–3.1. Maksu on ennakkomaksu: vero on suoritettava joulukuulta maksuhetken verokannalla "
         "(kirjan osuus 10 %), kirjaus 2880 Saadut ennakot. Tammikuussa toimitus tuloutetaan ilman uutta veroa. Klarna-tilaus "
         f"{D.KLARNA_DEC_ORDER_JAN_SHIP['id']} tehtiin 30.12., mutta Klarna veloittaa ja tilittää vasta toimitettaessa (2.1.): "
         "ennakkoa ei saatu, joten myynti on tammikuun ja kirjoista 14 %. Tulkintavaihtoehto: osa käytännöistä pitää "
         "Paytrailin tilityspäivää maksun saantipäivänä; avain käyttää asiakkaan maksupäivää, koska Paytrail toimii kauppiaan "
         "lukuun perivänä maksunvälittäjänä."),
        ("Lahjalaatikon (suklaa + kirja + muki) hinta jaetaan verokannoittain",
         "Yhteishinta 59,90 € (B2B 45,00 € alv 0) jaetaan osien hankintahintojen suhteessa 5,40 / 11,20 / 4,10: suklaa 14 %, "
         "kirja 10 % (2024) tai 14 % (2025), muki 25,5 %. Jako tehdään samoin verkkokaupassa, joulutorilla, B2B-laskulla ja "
         "palautuksessa. Vaihtoehto: jako myyntihintojen suhteessa on myös hyväksyttävä, kunhan menetelmä on johdonmukainen; "
         "avain käyttää hankintahintoja, koska laatikon osilla ei ole erillistä myyntihintaa laatikossa."),
        ("Toimitusmaksu seuraa tavaraa",
         "Asiakkaalta veloitettu toimitusmaksu on osa tavaran myyntihintaa ja jaetaan eri verokantojen kesken tavaroiden "
         "verottomien arvojen suhteessa (verkkokaupan asetus tekee saman). Rahti ei ole oma 25,5 %:n palvelu."),
        ("Joulukuun myynnin palautus tammikuussa alkuperäisellä verokannalla",
         "Palautus W-24-1402 (lahjalaatikko + toimitusmaksu) hyvitetään tammikuussa joulukuun verokannoin: kirjan osuus 10 %. "
         "Siksi tammikuun kausiveroilmoituksen 10 %:n rivi on negatiivinen. Hyvitys netotettiin 13.1. Paytrail-tilitykseen."),
        ("Takaisinveloitus (chargeback) = luottotappio",
         f"Paytrail veloitti 16.1. takaisin joulukuun kortti­maksun {D.PAYTRAIL['chargeback']['order']} ({fi(d['chargeback']['priced']['gross'])} €) "
         f"sekä käsittelymaksun {fi(m(D.PAYTRAIL['chargeback']['fee']))} €. Tavara oli toimitettu; riita hävittiin. Kirjataan "
         "lopullisena luottotappiona (7800) ja myynnin vero oikaistaan alkuperäisin verokannoin tammikuulta (AVL 78 §). "
         "Vaihtoehto: pitää saamisena, kunnes tappio on lopullinen – avain katsoo sen lopulliseksi."),
        ("Paytrail: nettotilitykset, viikkoerät ja pidätys",
         "Paytrail tilittää maanantaisin edellisen viikon maksut miinus 1,49 %:n palvelumaksu (veroton rahoituspalvelu). "
         "Ensimmäinen joulukuun tilitys sisältää myös 25.–30.11. maksut (avaava saaminen 1710). Palautukset ja "
         f"takaisinveloitus vähennetään seuraavasta tilityksestä. 23.12. tilityksestä pidätettiin {fi(pts['reserve'])} € "
         f"(sähköposti 15): tilille tuli {fi(pts['paid'])} €, vaikka raportin netto on {fi(pts['net'])} €. Ero kirjataan "
         "1720 Paytrail-pidätys, joka nollautuu 20.1. vapautuksella. Myynti kirjataan myyntiraportin mukaan, tilitykset "
         "vain kuittaavat välitiliä."),
        ("Klarna, Nexi ja MobilePay",
         "Klarna maksaa viikoittain (to) toimitettujen tilausten määrän miinus 2,99 %. Joulutorin kortti- ja MobilePay-myynnit "
         "tilitetään seuraavana pankkipäivänä; perjantain, lauantain ja sunnuntain myynnit tulevat yhtenä rivinä maanantaina. "
         "Palkkiot 6730 (verottomia). Joulutorin myynti kirjataan Z-raportin mukaan verokannoittain."),
        ("Amazon.de: myyjä on Karkkiaitta, palkkiot käännetyllä verolla",
         "Karkkiaitta on EU:hun sijoittunut myyjä ja toimittaa itse Oulusta (FBM), joten Amazon ei ole ns. oletettu "
         "myyjä: myynnit ovat yhtiön omaa etämyyntiä (lasketaan 10 000 euron rajaan). Tilitykset tulevat netto palkkioiden, "
         "kuukausimaksun ja mainonnan jälkeen; tilitysjaksot ylittävät kuukauden vaihteen. Amazon Services Europe (LU) "
         "laskuttaa palkkiot ilman ALV:tä -> käännetty verovelvollisuus 25,5 % (palveluostot muista EU-maista)."),
        ("OSS: 10 000 euron raja ylittyi 10.12.2024",
         f"EU-etämyynti 1–11/2024 oli {fi(pct(D.EU_DISTANCE_SALES_2024_JAN_NOV))} € (2023: {fi(pct(D.EU_DISTANCE_SALES_2023))} €). "
         f"Raja ylittyi tilauksella {D.EU_CROSSING_ORDER} ({fdate(cross['order']['date'])}, Ruotsi): jo tämä tilaus verotetaan "
         "määränpäämaassa. Sitä aiemmat joulukuun EU-tilaukset (verkkokauppa + Amazon) ovat Suomen ALV:n alaista myyntiä (tili "
         "3060, Suomen verokannat). Rajan ylittymisestä lähtien ja koko vuoden 2025 myynti Ruotsiin ja Saksaan verotetaan "
         "kohdemaan verokannoin (SE 12/6/25 %, DE 7/19 %) OSS-ilmoituksella, joka on neljännesvuosittainen ja erillinen "
         "kotimaan kausiveroilmoituksesta. Rekisteröityminen 18.12. oli ajoissa (viimeistään rajan ylittymistä seuraavan "
         f"kuukauden 10. päivänä). Q4/2024 OSS-vero {fi(d['oss_q4'])} € maksettiin 31.1. omalla RF-viitteellä. Huom: verkkokaupan "
         "asetus veloitti Suomen veroa 18.12. asti – myös tilauksista 10.–17.12., jotka kuuluivat jo OSS:ään."),
        ("Kadonnut paketti Ruotsiin",
         "W-24-1401 (OSS SE) hyvitettiin asiakkaalle tammikuussa. Myynti ja OSS-vero oikaistaan tammikuussa; OSS-ilmoituksella "
         "korjaus tehdään Q1/2025-ilmoituksen korjausosiossa kaudelle Q4/2024 (SE). Postin hyvityslasku: rahdin hyvitys "
         "oikaisee ostojen ALV-vähennystä, sisällön korvaus 58,00 € on vahingonkorvausta ilman ALV:tä (3990)."),
        ("Tuonti Isosta-Britanniasta (joulukuu)",
         f"Lasku GBP {fi(ukd['gbp'])} kirjataan laskun päivän kurssilla ({fi(ukd['eur_inv'])} €); maksu 16.12. pankin kurssilla "
         f"-> kurssiero {fi(ukd['fx'])} € (8900) ja palvelumaksu 9,00 €. Tulli 0 % (EU–UK-sopimuksen etuuskohtelu, "
         f"alkuperäilmoitus). Maahantuonnin ALV 14 % perusteesta {fi(ukd['base'])} € = {fi(ukd['ivat'])} € ilmoitetaan "
         "joulukuun kausiveroilmoituksella veroksi JA vähennykseksi – sitä ei makseta Tullille. Huolitsijan rahti on veroton, "
         "koska se sisältyy tuonnin veroperusteeseen; tullausmaksu on 25,5 %:n kotimainen palvelu."),
        ("Tuonti Kiinasta: FOB – omistus siirtyi joulukuussa, tullaus tammikuussa",
         f"Mukit lastattiin Ningbossa 10.12. (FOB): vaaranvastuu siirtyi, joten osto kuuluu joulukuulle ({fi(cnd['cost'])} €: "
         "marraskuun ennakko historiallisella kurssilla + loppuosa laskun päivän kurssilla) ja matkalla oleva tavara "
         "lisätään 31.12. varastoon, vaikka se ei ole inventaariolistalla. Maksu 12.12. -> kurssiero "
         f"{fi(cnd['fx'])} €. Tullaus 8.1.2025: tulli 9,0 % = {fi(cnd['duty'])} € (huolitsija laskuttaa läpilaskutuksena ilman ALV:tä) "
         f"ja maahantuonnin ALV 25,5 % = {fi(cnd['ivat'])} € tammikuun kausiveroilmoitukselle. Tullin tulliarvo lasketaan Tullin "
         "kurssilla, joten se poikkeaa kirjanpidon hankintamenosta – se on oikein."),
        ("Käännetty verovelvollisuus palveluista",
         "Meta ja Google (Irlanti), Shopify (Irlanti) ja Amazon Services Europe (Luxemburg): vero 25,5 % ilmoitetaan "
         "kohdassa \"vero palveluostoista muista EU-maista\" ja vähennetään. Mailchimp (USA) on EU:n ulkopuolinen palvelu: "
         "vero ilmoitetaan kohdassa \"vero kotimaan myynnistä\" 25,5 % (ei EU-kohtaan) ja vähennetään. Veron peruste on "
         "kortilta veloitettu euromäärä (vaihtoehto: EKP:n kurssi; ero sentin luokkaa)."),
        ("Osakkaiden erät",
         f"Liisan YEL-lasku 12/2024 ({fi(d['yel']['liisa'])} €) maksettiin 5.12. yhtiön tililtä vahingossa: YEL on yrittäjän "
         "henkilökohtainen maksu -> saaminen osakkaalta (1795), jonka Liisa maksoi takaisin 19.12. Tuomaksen YEL-lasku on "
         "aineistossa, mutta hän maksoi sen itse: ei kirjausta. Tuomas maksoi 7.12. pakkauslaskun 3391 omalta tililtään "
         f"({fi(t['owed'])} €, velka osakkaalle 2879) ja osti 12.1. yksityiset juoksukengät yhtiön kortilla ({fi(t['private'])} €, "
         f"saaminen 1795). Erät kuitataan: yhtiö maksoi 31.1. netto {fi(t['net'])} €. Vaihtoehto yhtiön maksamalle YEL:lle "
         "olisi käsitellä se osakkaan palkkana (ennakonpidätys ja tulorekisteri) – ei valittu, koska palkanmaksusta ei ole "
         "päätöstä ja maksu palautettiin."),
        ("Palkat: maksupäivä ratkaisee verokortin ja sivukuluprosentit",
         f"Marraskuun palkka maksettiin 10.12.2024 (2024: sava 1,16 %, TVR 0,79/0,27 %). Joulukuun palkka "
         f"({fi(P['P2']['gross'])} €, sis. iltalisät ja sunnuntaikorotuksen) maksettiin 10.1.2025: ennakonpidätys vuoden "
         "2025 verokortilla ja sivukulut vuoden 2025 prosenteilla (sava 1,87 %, TVR 0,59/0,20 %), vaikka kulu jaksotetaan "
         "joulukuulle. Työntekijä teki alle 14 pv/kk: lomakorvaus 9 % jaksotetaan kuukausittain sivukuluineen ja maksetaan "
         f"lopputilissä 7.2.2025 ({fi(P['P3']['holiday'])} €). Tammikuun palkka + lomakorvaus ({fi(P['P3']['gross'])} €) on "
         "31.1. palkkavelkana. Ennakonpidätys ja sava erääntyvät maksukuukautta seuraavan kuukauden 12. päivänä."),
        ("OmaVero: yksi maksu, monta verolajia – ja viivästyskorko",
         f"ALV 10/2024 (eräpäivä 12.12.) maksettiin vasta 20.12. -> viivästyskorko {fi(li['amount'])} € ({li['days']} pv). "
         f"13.1. yhdistetty maksu {fi(cp['total'])} € jaetaan: ALV 11/2024 {fi(cp['alv_nov'])}, ennakonpidätys {fi(cp['tax'])}, "
         f"sava {fi(cp['sava'])} (10.12. maksetut palkat) ja viivästyskorko {fi(cp['interest'])}. Korko kirjataan tammikuulle, "
         "kun se näkyy verotilillä (vaihtoehto: joulukuulle jaksottaen – määrä epäolennainen). OSS-maksu on erillinen."),
        ("Jaksotukset ja ennakkoon maksetut kulut",
         "Postin lasku 3.1.2025 koskee joulukuun lähetyksiä -> joulukuun kulu. Tapaturmavakuutuksen lasku 16.12.2024 koskee "
         "vuotta 2025 -> siirtosaaminen (1780), josta 1/12 tammikuulle. Lakisääteinen tapaturmavakuutus on "
         "vakuutusmaksuverosta vapaa eikä siinä ole ALV:tä."),
        ("Yritysasiakkaan myöhäinen maksu väärällä viitteellä ja liikasuoritus",
         f"Lasku {D.B2B_INVOICE['no']} (eräpäivä 19.12.) maksettiin 2.1.2025 viestillä \"{D.B2B_INVOICE['paid_message']}\" ilman "
         f"viitettä ja 40,00 € liikaa. Kohdistetaan asiakkaan ja summan perusteella; liikasuoritus 2881, palautus 13.1."),
        ("Lahjakortit ovat monikäyttöisiä arvoseteleitä",
         "Myyntihetkellä ei ALV:tä (velka 2878). Vero suoritetaan, kun kortti käytetään, sen hetken verokannalla: joulukuussa "
         f"käytetyt {fi(m(D.GIFTCARD_REDEEMED['2024-12']))} € joulukuun kannoin, tammikuussa käytetyt "
         f"{fi(m(D.GIFTCARD_REDEEMED['2025-01']))} € tammikuun kannoin (kirjat 14 %). B2B-laskun 20 lahjakorttia samoin."),
        ("Varasto ja hävikki",
         f"Laskettu varasto {fi(inv['count'])} € + matkalla olevat mukit {fi(inv['transit'])} € = {fi(inv['closing'])} €; "
         f"avaava {fi(inv['opening'])} € -> varaston muutos {fi(inv['change'])} € (4400). Hävitetyt vanhentuneet ja "
         f"rikkoutuneet tuotteet ({fi(inv['destroyed_total'])} €) sisältyvät muutokseen; ALV-vähennystä ei oikaista. "
         "Tammikuussa ei ole inventaariota: varaston muutosta ei kirjata (kuukausikirjanpito, tilinpäätöksessä laskenta). "
         "Palautettu lahjalaatikko palasi myyntivarastoon."),
        ("Muut",
         "Makeistukun laskujen tölkkipantit ovat ALV:n ulkopuolella (4005). Pakkauspöytä K-Raudasta (189,00 €) on "
         "pienhankinta (6800). Valuuttamaksujen palvelumaksut 6900. Marraskuun loppupäivien maksunvälityspalkkiot "
         "kirjataan joulukuun tilityksissä (epäolennainen jaksotusero)."),
    ]
    return items


def render_key(path, M):
    doc = Doc(path, "Kirjausohje ja vastaukset - Karkkiaitta Oy 12-2024-01-2025", margin=14 * mm)
    doc.text("KIRJAUSOHJE — TESTIAINEISTON VASTAUKSET", 15, bold=True)
    doc.text(f"{CO['name']} · {CO['ytunnus']} · Tarkastelujakso 1.12.2024–31.1.2025 · suoriteperuste · ALV-kausi kuukausi", 9)
    doc.para("Tämä dokumentti sisältää aineiston oletetut kirjanpidolliset ratkaisut. Kaikki aineiston yritykset, henkilöt, "
             "tunnukset, tilinumerot ja tapahtumat ovat kuvitteellisia. Luvut on tuotettu generaattorilla, joka tarkistaa, että "
             "jokainen vienti täsmää, tiliotteet täsmäävät sentilleen ja osan C luvut summautuvat osan B kirjauksista.", 8)
    doc.space(4)
    doc.text("A. KIRJAUSSÄÄNNÖT JA ANSAT", 11, bold=True)
    doc.para("Yleiset periaatteet: myynti kirjataan toimituspäivän mukaan kuukauden myyntiraporteista maksunvälittäjien "
             "välitileille (1710 Paytrail, 1711 Klarna, 1712 Amazon, 1713 Nexi, 1714 MobilePay), ja tilitykset vain kuittaavat "
             "välitilit (palkkio 6730). Ostolaskut kirjataan ostovelkoihin toimitus-/laskutuskuukaudelle, yrityskortin ostot "
             "korttilaskun erittelystä yrityskorttivelkaan 2895. ALV-tilit päätetään kuukauden lopussa tilille 2941. "
             "Kaikki avaavat saldot: ks. saldoluettelo (dokumentti 03).", 8)
    doc.space(2)
    for i, (h, body) in enumerate(section_a(M), 1):
        doc.need(30)
        doc.text(f"{i}. {h}", 9, bold=True)
        doc.para(body, 8)
        doc.space(2)

    # B1
    doc.newpage()
    doc.text("B. TILIOTTEEN TAPAHTUMIEN KIRJAUKSET", 11, bold=True)
    for month in ["2024-12", "2025-01"]:
        doc.text({"2024-12": "Joulukuu 2024", "2025-01": "Tammikuu 2025"}[month], 10, bold=True)
        rows = [entry_row(bl.entry) for bl in M.bank[month]]
        doc.table(["PVM", "TAPAHTUMA", "DEBET", "KREDIT", "HUOM"], rows, [0.06, 0.24, 0.29, 0.29, 0.12],
                  size=6.4, zebra=True)
    doc.text("B2. TOSITTEISIIN PERUSTUVAT KIRJAUKSET (EI TILIOTTEELLA)", 11, bold=True)
    doc.para("Myyntiraportit, ostolaskut, korttilaskun erittely, palkkajaksotukset, tuonnin ALV, varaston muutos ja "
             "ALV-kauden päättäminen. Tapahtumat, joilla on pankkirivi, ovat osassa B1.", 7.5, color=GREY)
    docs_entries = sorted([e for e in M.journal if e.kind != "bank"], key=lambda e: e.date)
    for month in ["2024-12", "2025-01"]:
        doc.text({"2024-12": "Joulukuu 2024", "2025-01": "Tammikuu 2025"}[month], 10, bold=True)
        rows = [entry_row(e) for e in docs_entries if month_of(e.date) == month]
        doc.table(["PVM", "TOSITE / TAPAHTUMA", "DEBET", "KREDIT", "HUOM"], rows, [0.06, 0.24, 0.29, 0.29, 0.12],
                  size=6.4, zebra=True)

    # C
    doc.newpage()
    doc.text("C. KUUKAUSIEN ODOTETUT SUMMAT", 11, bold=True)
    for month in ["2024-12", "2025-01"]:
        f = M.figures[month]
        nm = {"2024-12": "JOULUKUU 2024", "2025-01": "TAMMIKUU 2025"}[month]
        doc.need(60)
        doc.band(nm, 10, fill=colors.Color(0.25, 0.25, 0.25))
        doc.text("C1. Kausiveroilmoitus " + month[5:] + "/" + month[:4], 9, bold=True)
        rows = [[k, fi(v)] for k, v in f["return"].items()]
        rows += [["Peruste: " + k, fi(v)] for k, v in f["return_bases"].items()]
        due = {"2024-12": "12.2.2025", "2025-01": "12.3.2025"}[month]
        rows[len(f["return"]) - 1][0] += f" (eräpäivä {due})"
        doc.table(["KENTTÄ", "EUR"], rows, [0.78, 0.22], ["left", "right"], bold_rows=(len(f["return"]) - 1,), size=7.6)
        doc.text("C2. Kotimaan myynti verokannoittain (sis. ennakot ja EU-etämyynnin ennen kynnystä)", 9, bold=True)
        srows = []
        for rate in sorted(f["sale"], key=lambda r: -pct(r)):
            base, tax = f["sale"][rate]
            srows.append([f"{rate.replace('.', ',')} %", fi(base), fi(tax)])
        doc.table(["VEROKANTA", "VEROTON", "VERO"], srows, [0.4, 0.3, 0.3], ["left", "right", "right"], size=7.6)
        acct = f["acct"]
        memo = [["Tili 3060 EU-etämyynti Suomen ALV:lla (sisältyy yllä olevaan)", fi(-acct.get("3060", ZERO))],
                ["Ennakkomaksujen vero (sisältyy yllä olevaan)",
                 fi(sum((l.credit for e in M.journal if month_of(e.date) == month and e.text.startswith("Ennakkomaksu")
                         for l in e.lines if l.acct == "2939"), ZERO))]]
        doc.table(None, memo, [0.7, 0.3], ["left", "right"], size=7.3)
        doc.text("C3. OSS-myynti (erillinen OSS-ilmoitus, ei kotimaan ilmoitukselle)", 9, bold=True)
        orows = [[cc, f"{r.replace('.', ',')} %", fi(b), fi(t)] for (cc, r), (b, t) in sorted(f["oss"].items())]
        orows.append(["", "YHTEENSÄ", fi(sum((v[0] for v in f["oss"].values()), ZERO)), fi(sum((v[1] for v in f["oss"].values()), ZERO))])
        doc.table(["MAA", "KANTA", "VEROTON", "VERO"], orows, [0.2, 0.2, 0.3, 0.3], ["left", "left", "right", "right"],
                  bold_rows=(len(orows) - 1,), size=7.6)
        doc.text("C4. Vähennettävä vero ja käännetty verovelvollisuus", 9, bold=True)
        inp = f["input"]
        irows = [["Kotimaiset ostot (1760)", fi(inp.get("domestic", ZERO))],
                 ["Käännetty vero, EU-palvelut: vero = vähennys", f"{fi(f['rc_eu'][1])}  (peruste {fi(f['rc_eu'][0])})"],
                 ["Käännetty vero, EU:n ulkopuoliset palvelut: vero = vähennys", f"{fi(f['rc_noneu'][1])}  (peruste {fi(f['rc_noneu'][0])})"],
                 ["Maahantuonnin ALV: vero = vähennys",
                  "; ".join(f"{r.replace('.', ',')} %: {fi(v[1])} (peruste {fi(v[0])})" for r, v in sorted(f["import"].items())) or "0,00"],
                 ["Vähennettävä yhteensä", fi(sum(inp.values(), ZERO))]]
        doc.table(None, irows, [0.55, 0.45], ["left", "right"], bold_rows=(4,), size=7.4)
        doc.text("C5. Palkat ja muut kuukauden luvut", 9, bold=True)
        prow = [["Palkat (5000)", fi(acct.get("5000", ZERO))], ["Lomakorvaukset (5010)", fi(acct.get("5010", ZERO))],
                ["TyEL (6130)", fi(acct.get("6130", ZERO))], ["Sava (6410)", fi(acct.get("6410", ZERO))],
                ["Työttömyysvakuutus (6420)", fi(acct.get("6420", ZERO))], ["Tapaturmavakuutus (6430)", fi(acct.get("6430", ZERO))],
                ["Maksetut nettopalkat", fi(sum((-bl.amount for bl in M.bank[month] if bl.kind == "PALKKA"), ZERO))],
                ["Varaston muutos (4400, + = kulu)", fi(acct.get("4400", ZERO))],
                ["Maksunvälityksen palkkiot (6730)", fi(acct.get("6730", ZERO))],
                ["Lahjakorttivelka kuukauden lopussa (2878)", fi(-balances(M, month + ("-31")).get("2878", ZERO))]]
        doc.table(None, prow, [0.7, 0.3], ["left", "right"], size=7.4)
        doc.text("C6. Pankkitilin täsmäytys", 9, bold=True)
        bls = M.bank[month]
        op = bls[0].balance - bls[0].amount
        brow = [["Alkusaldo", fi(op)], ["Panot", fi(sum((b.amount for b in bls if b.amount > 0), ZERO))],
                ["Otot", fi(sum((b.amount for b in bls if b.amount < 0), ZERO))], ["Loppusaldo = kirjanpidon 1910", fi(bls[-1].balance)]]
        doc.table(None, brow, [0.7, 0.3], ["left", "right"], bold_rows=(3,), size=7.4)
        doc.text("C7. Tuloslaskelma tileittäin (kuukauden liike)", 9, bold=True)
        pl = [[a, ACCOUNTS[a], fi(-v)] for a, v in sorted(acct.items()) if a >= "3000" and v]
        pl.append(["", "TULOS (+ voitto)", fi(-sum((v for a, v in acct.items() if a >= "3000"), ZERO))])
        doc.table(["TILI", "NIMI", "EUR (+ tuotto / − kulu)"], pl, [0.1, 0.6, 0.3], ["left", "left", "right"],
                  bold_rows=(len(pl) - 1,), size=7.2)
        doc.text("C8. Tase-erien saldot kuukauden lopussa", 9, bold=True)
        bal = balances(M, month + "-31")
        br = [[a, ACCOUNTS[a], fi(v)] for a, v in sorted(bal.items()) if a < "3000" and v and a != "2370"]
        doc.table(["TILI", "NIMI", "SALDO (+ debet / − kredit)"], br, [0.1, 0.6, 0.3], ["left", "left", "right"], size=7.2)
    doc.space(4)
    doc.text("Tililuettelo", 9, bold=True)
    doc.para(" · ".join(f"{a} {n}" for a, n in ACCOUNTS.items()), 6.8)
    doc.save()
