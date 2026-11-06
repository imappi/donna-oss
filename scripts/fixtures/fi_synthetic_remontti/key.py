# The answer key ("90 Kirjausohje ja vastaukset") for the Remonttipalvelu
# Kivijärvi Oy pack: A = booking rules and traps, B = every bank line's booking
# (B1) plus the non-bank document/accrual journals (B2), C = month figures.
# Everything in B and C is printed FROM the model's journals — C is computed
# from B, never typed.

from __future__ import annotations

from reportlab.lib import colors
from reportlab.lib.enums import TA_RIGHT
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.units import mm
from reportlab.platypus import PageBreak, Spacer

import scenario as S
from model import ACCOUNTS, ALV_CODES, TREE_CODE, fmt
from render import GREY, LIGHT, P, PR, build_pdf, num, tbl


def row_id(pack, m, pred):
    ids = [r["id"] for r in pack.bank[m]["rows"] if pred(r)]
    assert ids, "no bank row matched"
    return ", ".join(ids)


def traps(pack):
    """The trap list. Each trap: id, title, text, docs (file numbers), lines (bank-line ids), outcome, alt (optional)."""
    b = lambda m, pred: row_id(pack, m, pred)  # noqa: E731
    s, p = pack.sales, pack.purchases
    ra, rs = pack.alv_return("AUG"), pack.alv_return("SEP")
    pa, ps = pack.payroll["AUG"], pack.payroll["SEP"]
    o = pack.omavero
    mi = pack.mileage
    T = []

    def t(title, text, docs, lines, outcome, alt=None):
        T.append(dict(id=f"A.{len(T) + 1}", title=title, text=text, docs=docs, lines=lines, outcome=outcome, alt=alt))

    t("ALV-kanta ja kausi ratkeavat suoritusajankohdasta, ei laskun päiväyksestä (1.9.2024)",
      "Kolme syyskuussa päivättyä asiakirjaa koskee elokuussa suoritettua: myyntilasku 2405 (Rinne, päivätty 3.9., terassi valmis 29.8.), ostolasku 59240 "
      "(päivätty 2.9., tavarat toimitettu 28.8.) ja puhelinlasku 8/2024 (päivätty 3.9., palvelu elokuussa). Kaikissa oikea kanta on 24 % ja kausi ELOKUU "
      "(suoriteperuste; elokuun ALV-ilmoitus annetaan vasta 12.10.).",
      ["14", "22", "32"], [b("SEP", lambda r: "RINNE" in r["party"]), b("SEP", lambda r: r["msg"].startswith("VIITE") and "RAKENNUSTARVIKE" in r["party"] and r["amount"] == -p["P59240"]["gross"]),
                           b("SEP", lambda r: "LINJAVERKKO" in r["party"])],
      f"Elokuun myyntiin 2405: veroton {fmt(s[2405]['net'])}, ALV 24 % {fmt(s[2405]['vat'])}; elokuun vähennyksiin 59240 {fmt(p['P59240']['vat'])} ja puhelin {fmt(p['PLV08']['vat'])}. "
      "Syyskuun pankkirivit vain kuittaavat saatavan/ostovelan.",
      "Kirjanpidossa laskun voi kirjata myös laskun päivälle, mutta ALV-kausi on joka tapauksessa elokuu; avain kirjaa suoriteperusteisesti elokuulle.")
    t("Verokannan muutoksen yli jatkunut urakka ja sen ennakko",
      "Salosen kylpyhuoneurakka alkoi 26.8. ja valmistui 6.9. ilman sovittuja osasuorituksia. Ennen 1.9. saatu ennakko (2402, maksettu 23.8.) verotetaan 24 %:lla "
      "vastaanottokuukautena (elokuu). Valmistuessaan keskeneräinen palvelu verotetaan valmistumishetken kannalla → loppulaskun 2406 koko laskutettava osa 25,5 %. "
      "EI päiväsuhteista jakoa elo/syyskuulle. Sama logiikka ostossa: aliurakoitsija Salmelan laatoitus 29.8.–5.9. valmistui syyskuussa → käännetty vero 25,5 %.",
      ["11", "15", "27"], [b("AUG", lambda r: "SALONEN" in r["party"]), b("SEP", lambda r: "SALONEN" in r["party"]), b("SEP", lambda r: "SALMELA" in r["party"])],
      f"Elokuu: ALV 24 % {fmt(s[2402]['vat'])} ennakosta (2710 Saadut ennakot {fmt(s[2402]['net'])}). Syyskuu: 2406 ALV 25,5 % {fmt(s[2406]['vat'])}; ennakko tuloutetaan 6.9. "
      f"(2710 → 3001) ilman uutta veroa. Salmela: käännetty ALV 25,5 % {fmt(p['P2024066']['rc_tax'])}.")
    t("Toimittaja käytti vanhaa 24 %:n kantaa syyskuun suoritukseen",
      "Konevuokraamo Jyväs Oy:n lasku 40118 (vuokra-aika 2.–6.9.) on laskutettu 24 %:lla. Oikea kanta olisi 25,5 %. Ostaja ei saa vähentää enempää kuin laskulla "
      "ilmoitettu vero, eikä ostaja itse 'korjaa' veroa 25,5 %:iin. Virhe on myyjän; pyydä oikaistu lasku.",
      ["28"], [b("SEP", lambda r: r["type"] == "TILISIIRTO" and "KONEVUOKRAAMO" in r["party"] and "TILI" in r["msg"]),
               b("SEP", lambda r: "KONEVUOKRAAMO" in r["party"] and r["type"] == "PALAUTUNUT MAKSU"),
               b("SEP", lambda r: "KONEVUOKRAAMO" in r["party"] and r["type"] == "TILISIIRTO" and "TILI" not in r["msg"])],
      f"Kulu 7400 {fmt(p['P40118']['net'])}, vähennys O24 {fmt(p['P40118']['vat'])} (ei {fmt(round(p['P40118']['net'] * 0.255))}). Kirjataan syyskuulle ostovelaksi.",
      "Jos myyjä lähettää oikaistun laskun (hyvitys + uusi 25,5 %), vähennys oikaistaan sen kuukauden ilmoituksella.")
    t("Ennakkoon maksettu vuokra rajapäivän molemmin puolin",
      "Hallin syyskuun vuokra laskutettiin 20.8. ja maksettiin 30.8. → ennen 1.9. maksettuun ennakkoon sovelletaan 24 % (laskulla oikein). Ostaja vähentää ennakon ALV:n "
      "MAKSUKUUKAUDELTA (AVL 141 §) eli elokuussa, vaikka kulu kuuluu syyskuulle (siirtosaaminen 31.8.). Lokakuun vuokra maksettiin 30.9. → 25,5 %, vähennys syyskuussa, "
      "siirtosaaminen 30.9. Elokuun vuokra maksettiin jo heinäkuussa (avaava siirtosaaminen).",
      ["03", "35", "36"], [b("AUG", lambda r: "TOURULA" in r["party"]), b("SEP", lambda r: "TOURULA" in r["party"])],
      f"Elokuun 307: {fmt(p['PVR09']['vat'])}; syyskuun 307: {fmt(p['PVR10']['vat'])}. Vuokrakulu 7000 850,00 kumpanakin kuukautena (B2).")
    t("Rakentamispalvelun myynti rakennusliikkeelle: käännetty verovelvollisuus (AVL 8 c §)",
      "Laskut 2401 ja 2409 Rakennus Oy Harjuntaukselle ja oikaistu lasku 2408 Kattoasennus Rautio Oy:lle: ei ALV:tä, merkintä 'Käännetty verovelvollisuus, AVL 8 c §' "
      "ja ostajan ALV-tunniste. Myynti ilmoitetaan kenttään 319.",
      ["10", "17", "18"], [b("SEP", lambda r: "HARJUNTAUS" in r["party"] and r["amount"] > 500000)],
      f"319 elokuu {fmt(ra['319'])}, syyskuu {fmt(rs['319'])}.")
    t("Asunto-osakeyhtiö EI ole käännetyn verovelvollisuuden piirissä",
      "As Oy Jyväskylän Kotikallio ostaa rakentamispalvelua mutta ei itse myy sitä → laskussa 2404 kuuluu olla normaali ALV (24 %, työ valmis 22.8.). "
      "Kone, joka päättelee 'rakennustyö yhteisölle → käännetty', tekee tässä virheen.",
      ["13"], [b("SEP", lambda r: "KOTIKALLIO" in r["party"])],
      f"Elokuun myynti 24 %: {fmt(s[2404]['net'])} + ALV {fmt(s[2404]['vat'])}. Osamaksu 20.9. 2 000,00 → avoinna 30.9. {fmt(s[2404]['gross'] - 200000)}.")
    t("Rakennusliikkeelle laskutettu virheellisesti ALV:n kanssa",
      "Lasku 2403 Kattoasennus Rautio Oy:lle (kattourakoitsija, myy rakentamispalveluja) sisältää ALV 24 % 444,00. Laskulla ilmoitettu vero on suoritettava, kunnes "
      "lasku oikaistaan (AVL 85 a §). Asiakas huomautti; 11.9. annettiin hyvityslasku 2407 ja oikaistu lasku 2408 ilman veroa. Asiakas maksoi 23.9. VANHAN laskun "
      "viitteellä oikaistun laskun summan 1 850,00.",
      ["12", "16", "17", "08"], [b("SEP", lambda r: "RAUTIO" in r["party"])],
      "Elokuu: 2403 myynti 24 % 1 850,00 + ALV 444,00 (kenttä 301). Syyskuu: 2407 peruu myynnin ja veron (−444,00), 2408 kenttään 319. Suoritus kohdistetaan laskulle 2408.",
      "Koska virhe havaittiin ennen elokuun ilmoituksen antamista (12.10.), elokuun ilmoituksen voi myös laatia suoraan oikein (319, ei 301-veroa). Avain noudattaa "
      "tositteiden päiväyksiä (hyvitys syyskuulle); molempien kuukausien summa on sama.")
    t("Käännetty verovelvollisuus ostoissa: aliurakoitsijat",
      "Sähköasennus Ranta Oy (työ 6.–8.8., ei ALV:tä) ja Laatoitus Salmela Oy (työ valmis 5.9.). Ostaja ilmoittaa veron (318), perusteen (320) ja vähentää veron (307). "
      "Salmelan työn loppuasiakas on kuluttaja, mutta ratkaisevaa on, että Remonttipalvelu Kivijärvi Oy itse myy rakentamispalveluja.",
      ["26", "27"], [b("AUG", lambda r: "RANTA" in r["party"]), b("SEP", lambda r: "SALMELA" in r["party"])],
      f"Elokuu 318 {fmt(ra['318'])} (24 %), 320 {fmt(ra['320'])}; syyskuu 318 {fmt(rs['318'])} (25,5 %), 320 {fmt(rs['320'])}. Nettovaikutus 0.")
    t("Hyvityslasku ja bonus alkuperäisen toimituksen verokannalla",
      "Hyvityslasku 59377 (palautus 9.9.) hyvittää 28.8. toimitettuja tavaroita → 24 %, vaikka hyvitys on syyskuulta; hyvitys maksettiin tilille 25.9. "
      "Lasku 59611 sisältää sekä syyskuun tavaroita 25,5 % että alkuvuoden ostoihin perustuvan bonuksen −86,00 24 %:lla: kaksi kantaa samalla laskulla.",
      ["23", "24", "25"], [b("SEP", lambda r: r["msg"].startswith("HYVITYSLASKU")), b("SEP", lambda r: r["msg"].startswith("LASKUT"))],
      f"59377: vähennyksen oikaisu −{fmt(-p['P59377']['vat'])} (O24). 59611: O255 {fmt(p['P59611']['vat_by_rate']['25.5'])} ja O24 {fmt(p['P59611']['vat_by_rate']['24'])}.")
    t("Kotitalousvähennyksen työn osuus", "Kuluttajalaskut 2405, 2406 ja 2410 erittelevät työn osuuden (sis. ALV). Kirjanpitovaikutusta ei ole, mutta osuuden on oltava "
      "oikein: 2406:ssa työ on 25,5 %:n kannalla (ennakko koski materiaaleja). Asunto-osakeyhtiön ja yritysten laskuilla työn osuutta ei eritellä.",
      ["14", "15", "19"], [],
      f"Työn osuus: 2405 {fmt(s[2405]['household_work'])}, 2406 {fmt(s[2406]['household_work'])}, 2410 {fmt(s[2410]['household_work'])}.")
    t("Palkat: ikäsidonnainen TyEL, verovapaat korvaukset, palkkaennakko ja maksujen ajoitus",
      "Ari Haapala on 56-vuotias → työntekijän TyEL 8,65 % (ei 7,15 %); työnantajaosuus = 24,85 % palkkasummasta − työntekijäosuudet. Sava 1,16 %, "
      "työttömyysvakuutus työnantaja 0,27 % / työntekijä 0,79 %. Km-korvaus 0,57 €/km ja päivärahat 51/24 € ovat verovapaita (ei pidätystä). "
      "Mikko Lahtisen 15.8. palkkaennakko 500,00 vähennetään 30.8. palkasta. Elokuun ennakonpidätys ja sava maksetaan 12.9., TyEL 20.9.",
      ["50", "51", "52", "53", "54"], [b("AUG", lambda r: r["type"] == "PALKKA"), b("SEP", lambda r: r["type"] == "PALKKA"), b("AUG", lambda r: "ENNAKKO" in r["msg"])],
      f"Elokuu: brutto {fmt(pa['gross'])}, netto {fmt(pa['net'])}, TyEL tt {fmt(pa['tyel_employee'])} / ta {fmt(pa['tyel_employer'])}. Syyskuu: brutto {fmt(ps['gross'])}, netto {fmt(ps['net'])}.")
    t("OmaVero: yksi maksu, useita eriä ja kausia, viivästyskorko",
      f"Verohallinnolle maksetaan yhdellä viitteellä. 21.8. maksu {fmt(o['aug_total'])} kattaa ALV 6/2024:n, ennakonpidätyksen 7/2024 ja savan 7/2024 (eräpäivä 12.8.) — "
      f"{o['days_late']} päivää myöhässä → viivästyskorko 11,0 % = {fmt(o['interest'])}. 12.9. maksu {fmt(o['sep_total'])} = ALV 7/2024 + ennakonpidätys ja sava 8/2024 + viivästyskorko.",
      ["07"], [b("AUG", lambda r: r["party"] == "VEROHALLINTO"), b("SEP", lambda r: r["party"] == "VEROHALLINTO")],
      "Jaetaan veloiksi (2939/2931/2932) ja viivästyskorko 8850 (tuloverotuksessa vähennyskelvoton, ei ALV). Mikään osa ei ole kulua paitsi korko.")
    t("YEL on omistajan henkilökohtainen vakuutus — kysy omistajalta",
      "YEL-laskut on osoitettu Janne Kivijärvelle henkilönä ja maksettu yhtiön tililtä. Yhtiön maksama YEL on joko osakkaan palkkaa (ennakonpidätys + tulorekisteri) "
      "tai osakkaalta perittävä saaminen. Omistajan viesti ('niin kuin ennenkin') ei kerro, kumpi on sovittu — tämä on liiketoiminnan FAKTA, jonka vain omistaja tietää.",
      ["58", "59", "08"], [b("AUG", lambda r: pack.yel["YEL08"]["viite"] in r["msg"]), b("SEP", lambda r: pack.yel["YEL09"]["viite"] in r["msg"])],
      "Terminaali: KYSY OMISTAJALTA. Väliaikaisesti 1790 Selvittelytili 723,00 + 723,00; ei kulukirjausta ennen vastausta.",
      "Jos palkaksi sovittu: kulu (henkilösivukulu/palkka), ennakonpidätys ja tulorekisteri-ilmoitus puuttuvat ja on korjattava. Jos ei: saaminen osakkaalta. "
      "HUOM: YEL:n verokohtelu yhtiön maksamana on kirjattu muistinvaraisesti — VAHVISTAMATON (ks. README).")
    t("Yrityskortti: yksi veloitus, monta ostoa — ja neljä ansaa",
      "Elokuun korttilasku (659,81) veloitetaan kerralla 16.9. Ostot kirjataan elokuulle riveittäin: (a) ElektroNetti 14.8. on yksityinen → 1780; (b) Tankki Kuokkala 29.8. "
      "58,20: kuitti puuttuu → ei ALV-vähennystä, kysy omistajalta; (c) RautaMaailma 27.8.: kaksi kuvaa samasta kuitista → kirjataan kerran; (d) Lounaskeidas 20.8. "
      "on edustus → ALV 14 % ei vähennyskelpoinen; (e) SiteMeasure USD → palveluosto EU:n ulkopuolelta (AVL 9 §), oma vero 301 + vähennys 307, valuuttamuunnosmaksu "
      "veroton pankkikulu. Syyskuun korttilasku on päivätty 1.10. → ostot syyskuulle, korttivelka 30.9.",
      ["05", "06", "70", "71", "72", "73", "74", "75", "76", "78", "79", "80", "81", "08"],
      [b("AUG", lambda r: "VISA" in r["party"]), b("SEP", lambda r: "VISA" in r["party"])],
      f"Elokuu: UPO24 vero/vähennys {fmt(ra['UPO_tax'])}; syyskuu UPO255 {fmt(rs['UPO_tax'])}. 30.9. korttivelka {fmt(pack.card['SEP']['total'])}.")
    t("Omistajan yksityinen lasku yhtiön tililtä ja palautus",
      "12.8. yhtiön tililtä maksettiin Keski-Suomen Sähkönmyynnin lasku 49,45 — omistajan kodin sähkö (lasku osoitettu kotiosoitteeseen). 10.9. omistaja palautti "
      "yhdellä maksulla sekä sähkön että korttiostoksen ElektroNetti 139,80.",
      ["38", "08"], [b("AUG", lambda r: "SÄHKÖNMYYNTI" in r["party"]), b("SEP", lambda r: "PALAUTUS YKSITYISET" in r["msg"])],
      "1780 Saamiset osakkaalta (ei kulu, ei ALV). Osakeyhtiössä ei käytetä 'yksityisotot'-tiliä.")
    t("Omistajan kulukorvaukset: käteiskuitti, ajopäiväkirja, työmatka",
      "Omistaja maksoi 27.8. omilla rahoillaan sepelikuorman (käsin kirjoitettu kuitti, 120,00 sis. 24 %) ja haki 30.9. km-korvaukset 8–9/2024 "
      f"({mi['km_total']} km × 0,57 = {fmt(mi['claimed_total'])}). Molemmat maksettiin yhdellä siirrolla 30.9. Elokuun ajot ja käteisostos jaksotetaan elokuulle. "
      "5.9. ajo koti – Kuormaajankatu 3 on asunnon ja yhtiön omien toimitilojen (vakituinen työpaikka) välinen matka → ei verovapaata km-korvausta.",
      ["55", "77", "08"], [b("SEP", lambda r: "KULUKORVAUKSET" in r["msg"])],
      f"Elokuu: 4000/1760 käteisostos, 7810 {fmt(mi['AUG']['claimed'])} → 2891. Syyskuu: 7810 {fmt(mi['SEP']['taxfree'])}, liikaa maksettu {fmt(mi['SEP']['excess'])} → 1780.",
      "Liikaa maksetun km-korvauksen voi vaihtoehtoisesti käsitellä veronalaisena palkkana (ennakonpidätys, tulorekisteri). Avain perii sen osakkaalta.")
    t("Asiakkaan maksut: yksi suoritus kahdelle laskulle, väärä viite, osamaksu, myöhästyminen",
      "Harjuntaus maksoi 27.9. laskut 2401 (erääntyi 30.8.) ja 2409 yhdellä 9 800,00 suorituksella laskun 2401 viitteellä. Kotikallio maksoi 20.9. osamaksun 2 000,00. "
      "Rautio maksoi vanhan laskun viitteellä (A.7).",
      ["10", "18", "13"], [b("SEP", lambda r: "HARJUNTAUS" in r["party"]), b("SEP", lambda r: "KOTIKALLIO" in r["party"])],
      "Suoritus jaetaan kahdelle laskulle; osamaksun jälkeen 2404 jää avoimeksi (ei luottotappio).")
    t("Palautunut maksu ja palautuksen käsittelykulu",
      "19.9. maksu Konevuokraamolle meni väärälle tilinumerolle (kirjoitusvirhe), pankki palautti sen 23.9. ja veloitti 5,00 käsittelykulun; oikea maksu 24.9.",
      ["28"], [b("SEP", lambda r: r["type"] == "PALAUTUNUT MAKSU"), b("SEP", lambda r: "Palautuneen" in r["msg"])],
      "Kolme pankkiriviä nettoutuvat yhteen ostovelan suoritukseen; kulu 7800 5,00.")
    t("Korttimaksun tilitys (SumUp)", "Väänäsen lasku 2410 maksettiin kortilla paikan päällä; SumUp tilitti 23.9. netto (palkkio 1,69 %).",
      ["19", "20"], [b("SEP", lambda r: r["type"] == "SUMUP TILITYS")],
      f"Myynti bruttona laskulta 2410 ({fmt(s[2410]['gross'])}); palkkio {fmt(pack.sumup['fee'])} 7800, arvonlisäveroton.")
    t("Lainaerän jako", "Lainanhoitoerä jaetaan lainalaskelman mukaan korkoon ja lyhennykseen. 28.9. on lauantai → veloitus 30.9.",
      ["04"], [b("AUG", lambda r: r["type"] == "LAINANHOITO"), b("SEP", lambda r: r["type"] == "LAINANHOITO")],
      f"Elokuu korko {fmt(pack.loan[0]['interest'])}, syyskuu {fmt(pack.loan[1]['interest'])}; lyhennys 500,00 / kk.")
    t("Työeläke- ja työttömyysvakuutuslaskut koskevat edellisiä kuukausia",
      "TyEL 7/2024 (maksettu 20.8.) koskee heinäkuun palkkoja (avaava velka). Työllisyysrahaston lasku kattaa palkat 5–8/2024; rahasto laskee maksun palkkasummasta, "
      "kirjanpito henkilöittäin → 0,01 € pyöristysero.",
      ["56", "57", "60", "03"], [b("AUG", lambda r: pack.tyel["TYEL07"]["viite"] in r["msg"]), b("SEP", lambda r: pack.tyel["TYEL08"]["viite"] in r["msg"]), b("SEP", lambda r: "TYÖLLISYYSRAHASTO" in r["party"])],
      f"TVR-lasku {fmt(pack.tvr['total'])} = kertynyt velka {fmt(pack.tvr['accrued'])} + ero {fmt(pack.tvr['rounding_diff'])} (6140).")
    t("Vakuutuslasku: vakuutusmaksuvero ei ole ALV:tä, ja vastuuvakuutus on ennakkoon maksettu",
      "Lasku sisältää '25,5 %' — se on vakuutusmaksuvero (kanta nousi 1.9.2024), ei arvonlisävero. Vastuuvakuutuksen kausi 1.10.2024–30.9.2025 → siirtosaaminen 30.9.",
      ["37"], [b("SEP", lambda r: "KOTISEUTU" in r["party"])],
      "6150 tapaturma 384,00; 1800 vastuuvakuutus + vakuutusmaksuvero 577,30; ei ALV-vähennystä.")
    t("Pakettiauton leasing on vähennyskelpoinen", "Nordvanin leasing koskee pakettiautoa (N1) → ALV vähennetään (henkilöauton ALV ei olisi vähennyskelpoinen). "
      "Elokuun lasku 24 %, syyskuun 25,5 % (laskutuskausi).", ["29", "30"], [b("AUG", lambda r: "NORDVAN" in r["party"]), b("SEP", lambda r: "NORDVAN" in r["party"])],
      f"O24 {fmt(p['PNV08']['vat'])} / O255 {fmt(p['PNV09']['vat'])}.")
    t("Heinäkuun puhelinlasku saapui elokuussa", "Linjaverkon heinäkuun lasku (päivätty 2.8.) koskee suljettua heinäkuuta, eikä avaava saldo sisällä jaksotusta.",
      ["31"], [b("AUG", lambda r: "LINJAVERKKO" in r["party"])], f"Avain kirjaa elokuulle (olennaisuus) ja vähentää ALV:n {fmt(p['PLV07']['vat'])} elokuussa.",
      "Tarkka suoriteperuste kuuluisi heinäkuulle, mutta suljettua kautta ei avata pienen erän takia; ALV:n voi vähentää kaudella, jolla lasku saatiin.")
    return T


def dc_cell(lines, side):
    out = []
    for l in lines:
        amt = l.dr if side == "d" else l.cr
        if amt:
            out.append(f"{l.acc} {ACCOUNTS[l.acc]} {fmt(amt)}" + (f" ({l.note})" if l.note and l.acc not in ("1910",) else ""))
    return "\n".join(out)


def alv_cell(lines):
    codes = []
    for l in lines:
        if l.alv and l.alv not in codes:
            codes.append(l.alv)
    return ", ".join(codes) if codes else "—"


def render_key(pack, path):
    story = []
    co = pack.company
    story.append(PR(f"<b>KIRJAUSOHJE — TESTIAINEISTON VASTAUKSET</b>", size=15))
    story.append(P(f"{co['name']} · {co['ytunnus']} · Tarkastelujakso 1.8.–30.9.2024 (kaksi ALV-kautta)", size=10, color=GREY))
    story.append(P("Tämä dokumentti sisältää aineiston oletetut kirjanpidolliset ratkaisut. Käytä sitä parserin/automaation tulosten vertailuun. Kaikki aineiston yritykset, "
                   "henkilöt, y-tunnukset, tilinumerot, viitteet ja tapahtumat ovat kuvitteellisia (julkiset laitokset Verohallinto ja Työllisyysrahasto esiintyvät nimellä, "
                   "mutta niiden maksutiedot ovat synteettisiä). Osa B ja C on tulostettu suoraan generaattorin kirjauksista; generaattori tarkistaa, että kaikki täsmää sentilleen.",
                   size=8.5))
    story.append(Spacer(1, 3 * mm))
    story.append(P("A. KIRJAUSSÄÄNNÖT JA ANSAT", size=12, bold=True))
    rules = [
        "Suoriteperuste. ALV-kausi 1 kk; ALV-kausi määräytyy suoritusajankohdasta (tavara toimitettu / palvelu valmis), ennakkomaksuissa maksun vastaanotto- tai maksukuukaudesta.",
        "Yleinen verokanta 24 % ennen 1.9.2024 ja 25,5 % 1.9.2024 alkaen suoritetuille (ks. A.1–A.4). Alennettu 14 % (ravintola) ennallaan.",
        "Myyntilaskut kirjataan aina myyntisaamisiksi (B2) ja maksut kuittaavat ne (B1). Ostolaskut, jotka on päivätty ja maksettu samana kuukautena, kirjataan suoraan "
        "maksun yhteydessä (B1). Kuukauden rajan ylittävät ja useampaan pankkiriviin jakautuvat ostolaskut kulkevat ostovelan (2890) kautta (B2). HYVÄKSYTÄÄN MYÖS: saman kuukauden "
        "ostolasku ostovelan kautta — kunhan kausi, tili ja ALV-koodi ovat samat.",
        "Kaksi terminaalitilaa: jokainen rivi on joko KIRJATTU tai KYSY OMISTAJALTA. Tässä aineistossa omistajalta kysytään kolme asiaa: YEL 8 ja YEL 9 (A.13) sekä puuttuva kuitti (A.14). "
        "Niiden väliaikainen kirjaus on 1790 Selvittelytili.",
        "Osakeyhtiössä omistajan yksityiset menot ovat saamisia osakkaalta (1780), ei 'yksityisottoja'. Omistajalle maksettavat kulukorvaukset ovat velkaa osakkaalle (2891).",
    ]
    for i, r in enumerate(rules):
        story.append(P(f"A.0.{i + 1}  {r}", size=8.3))
    story.append(Spacer(1, 2 * mm))
    story.append(P("ALV-koodit (kausiveroilmoituksen kentät) ja vastaava Donnan ALV-koodi (server/donna/finland/alvCodes.js):", size=8.3, bold=True))
    story.append(tbl([[P("KOODI", size=7, bold=True), P("MERKITYS", size=7, bold=True), P("DONNA-KOODI", size=7, bold=True)]] +
                     [[P(k, size=7.8), P(v, size=7.8), P(TREE_CODE[k] or "— (ei vastinetta)", size=7.8)] for k, v in ALV_CODES.items()],
                     [20 * mm, 170 * mm, 60 * mm], repeat=1, zebra=True))
    story.append(Spacer(1, 3 * mm))
    for tr in traps(pack):
        block = [P(f"{tr['id']} {tr['title']}", size=9.2, bold=True), P(tr["text"], size=8.2),
                 P(f"Oikea ratkaisu: {tr['outcome']}", size=8.2, bold=True)]
        if tr.get("alt"):
            block.append(P(f"Vaihtoehtoinen käsittely: {tr['alt']}", size=8, italic=True))
        refs = []
        if tr["docs"]:
            refs.append("Tositteet: " + ", ".join(tr["docs"]))
        if tr["lines"]:
            refs.append("Pankkirivit: " + "; ".join(tr["lines"]))
        if refs:
            block.append(P(" · ".join(refs), size=7.5, color=GREY))
        block.append(Spacer(1, 2 * mm))
        story += block
    story.append(PageBreak())

    # ── B ──
    story.append(P("B. KIRJAUKSET", size=12, bold=True))
    story.append(P("B1 = jokainen tiliotteen rivi. B2 = tositteiden ja jaksotusten kirjaukset, joihin ei liity pankkiriviä (myyntilaskut, kuun rajan ylittävät ostot, "
                   "korttiostot, palkkojen sivukulut, jaksotukset). Tilin 1910 vastakirjaus = tiliotteen summa. 'KYSY' = terminaali on kysymys omistajalle.", size=8.3))
    hdr = ["RIVI", "PVM", "TAPAHTUMA", "MÄÄRÄ", "DEBET", "KREDIT", "ALV", "HUOM"]
    widths = [17 * mm, 14 * mm, 38 * mm, 18 * mm, 62 * mm, 55 * mm, 16 * mm, 45 * mm]
    for m, lab in (("AUG", "ELOKUU 2024"), ("SEP", "SYYSKUU 2024")):
        story.append(Spacer(1, 2 * mm))
        story.append(P(f"B1 · {lab} · alkusaldo {fmt(pack.bank[m]['opening'])} → loppusaldo {fmt(pack.bank[m]['closing'])}", size=9.5, bold=True))
        rows = [[P(h, size=6.8, bold=True, color=colors.white, align=(TA_RIGHT if h == "MÄÄRÄ" else 0)) for h in hdr]]
        for j in [j for j in pack.journals if j.kind == "bank" and j.period == m]:
            r = j.bank
            huom = j.note + ("  → KYSY OMISTAJALTA" if j.terminal == "ask_owner" else "")
            rows.append([P(j.id, size=7), P(f"{int(r['date'][8:10])}.{int(r['date'][5:7])}.", size=7), P(f"{r['type']}\n{r['party']}\n{r['msg']}", size=6.8),
                         P(fmt(r["amount"], plus=True), size=7, bold=True, align=TA_RIGHT), P(dc_cell(j.lines, "d"), size=6.8), P(dc_cell(j.lines, "c"), size=6.8),
                         P(alv_cell(j.lines), size=6.8), P(huom, size=6.5)])
        story.append(tbl(rows, widths, repeat=1, zebra=True, head_bg=colors.HexColor("#333333")))
    for m, lab in (("AUG", "ELOKUU 2024"), ("SEP", "SYYSKUU 2024")):
        story.append(Spacer(1, 3 * mm))
        story.append(P(f"B2 · {lab} · tositteet ja jaksotukset ilman pankkiriviä", size=9.5, bold=True))
        rows = [[P(h, size=6.8, bold=True, color=colors.white) for h in ["TOSITE", "PVM", "SELITE", "", "DEBET", "KREDIT", "ALV", "HUOM"]]]
        for j in [j for j in pack.journals if j.kind == "memo" and j.period == m]:
            huom = j.note + ("  → KYSY OMISTAJALTA (ks. A.14)" if "1790" in [l.acc for l in j.lines] else "")
            rows.append([P(j.id, size=7), P(f"{int(j.date[8:10])}.{int(j.date[5:7])}.", size=7), P(j.text, size=6.8), P("", size=6.8),
                         P(dc_cell(j.lines, "d"), size=6.8), P(dc_cell(j.lines, "c"), size=6.8), P(alv_cell(j.lines), size=6.8), P(huom, size=6.5)])
        story.append(tbl(rows, widths, repeat=1, zebra=True, head_bg=colors.HexColor("#555555")))
    story.append(PageBreak())

    # ── C ──
    story.append(P("C. KUUKAUSIEN ODOTETUT SUMMAT (laskettu osan B kirjauksista)", size=12, bold=True))
    cw = [120 * mm, 38 * mm, 38 * mm, 60 * mm]
    ra, rs = pack.alv_return("AUG"), pack.alv_return("SEP")
    sa, ss = pack.sales_pl("AUG"), pack.sales_pl("SEP")
    pa, ps = pack.payroll["AUG"], pack.payroll["SEP"]

    def sec(title, items):
        rows = [[P(title, size=7.5, bold=True, color=colors.white), P("ELOKUU", size=7.5, bold=True, color=colors.white, align=TA_RIGHT),
                 P("SYYSKUU", size=7.5, bold=True, color=colors.white, align=TA_RIGHT), P("HUOM", size=7.5, bold=True, color=colors.white)]]
        for lab, a, b_, note in items:
            rows.append([P(lab, size=8), num(a, size=8) if a is not None else "", num(b_, size=8) if b_ is not None else "", P(note, size=7)])
        return tbl(rows, cw, repeat=1, zebra=True, head_bg=colors.HexColor("#333333"))

    story.append(sec("MYYNTI (tuloslaskelma, veroton)", [
        ("3000 Myynti 25,5 %", sa["3000"], ss["3000"], "2406 + 2410"),
        ("3001 Myynti 24 %", sa["3001"], ss["3001"], "elokuu 2403 + 2404 + 2405; syyskuu ennakon 2402 tuloutus 2 000,00 − hyvitys 2407 1 850,00"),
        ("3010 Rakentamispalvelut, käännetty", sa["3010"], ss["3010"], "2401; 2408 + 2409"),
        ("Myynti yhteensä", sum(sa.values()), sum(ss.values()), ""),
        ("Verollinen myynti 24 % (ALV-peruste, ml. saatu ennakko)", ra["M24_base"], rs["M24_base"], "elokuu ml. ennakko 2402 2 000,00; syyskuu hyvitys"),
        ("Verollinen myynti 25,5 %", ra["M255_base"], rs["M255_base"], ""),
    ]))
    story.append(Spacer(1, 3 * mm))
    story.append(sec("ALV-ILMOITUS (kausiveroilmoitus)", [
        ("301 Vero kotimaan myynnistä, yleinen verokanta — josta myynti 24 %", ra["M24_tax"], rs["M24_tax"], "syyskuussa hyvityksen 24 %:n oikaisu"),
        ("   — josta myynti 25,5 %", ra["M255_tax"], rs["M255_tax"], ""),
        ("   — josta palveluostot EU:n ulkopuolelta (AVL 9 §)", ra["UPO_tax"], rs["UPO_tax"], "SiteMeasure"),
        ("301 yhteensä", ra["301"], rs["301"], "24 %:n ja 25,5 %:n kenttäjako OmaVerossa: ks. README (vahvistamaton)"),
        ("318 Vero rakentamispalvelujen ostoista", ra["318"], rs["318"], "Ranta 24 %; Salmela 25,5 %"),
        ("307 Verokauden vähennettävä vero — kotimaiset ostot", ra["O_tax"], rs["O_tax"], "ilman edustusta, yksityisiä ja puuttuvaa kuittia"),
        ("   — käännetty rakentamispalvelu", ra["RAKO_deduct"], rs["RAKO_deduct"], ""),
        ("   — palveluostot EU:n ulkopuolelta", ra["UPO_deduct"], rs["UPO_deduct"], ""),
        ("307 yhteensä", ra["307"], rs["307"], ""),
        ("308 Maksettava vero (301 + 318 − 307)", ra["308"], rs["308"], "eräpäivät 12.10.2024 / 12.11.2024"),
        ("319 Rakentamispalvelujen myynnit (käännetty)", ra["319"], rs["319"], ""),
        ("320 Rakentamispalvelujen ostot (käännetty)", ra["320"], rs["320"], ""),
    ]))
    story.append(Spacer(1, 3 * mm))
    story.append(sec("PALKAT", [
        ("Bruttopalkat (5000)", pa["gross"], ps["gross"], "kaksi työntekijää; omistaja ei nostanut palkkaa"),
        ("Ennakonpidätykset", pa["withholding"], ps["withholding"], "Verohallinnolle 12.9. / 12.10."),
        ("TyEL työntekijäosuudet", pa["tyel_employee"], ps["tyel_employee"], "7,15 % ja 8,65 %"),
        ("Työttömyysvakuutus, palkansaaja 0,79 %", pa["tvr_employee"], ps["tvr_employee"], ""),
        ("Km-korvaukset työntekijöille (verovapaa)", pa["km"], ps["km"], ""),
        ("Päivärahat (verovapaa)", pa["pd"], ps["pd"], ""),
        ("Palkkaennakko vähennetty", pa["advance"], ps["advance"], ""),
        ("Nettopalkat maksettu", pa["net"], ps["net"], ""),
        ("TyEL yhteensä 24,85 %", pa["tyel_total"], ps["tyel_total"], "Kantele 20.9. / 20.10."),
        ("TyEL työnantajaosuus (6100)", pa["tyel_employer"], ps["tyel_employer"], ""),
        ("Sava 1,16 % (6130)", pa["sava"], ps["sava"], ""),
        ("Työttömyysvakuutus, työnantaja 0,27 % (6140)", pa["tvr_employer"], ps["tvr_employer"], ""),
        ("Omistajan km-korvaukset, verovapaa osa (7810)", pack.mileage["AUG"]["claimed"], pack.mileage["SEP"]["taxfree"], f"syyskuun työmatka {fmt(pack.mileage['SEP']['excess'])} → 1780"),
    ]))
    story.append(Spacer(1, 3 * mm))
    ba, bs = pack.bank["AUG"], pack.bank["SEP"]
    story.append(sec("PANKKI", [
        ("Alkusaldo", ba["opening"], bs["opening"], ""),
        ("Panot", sum(r["amount"] for r in ba["rows"] if r["amount"] > 0), sum(r["amount"] for r in bs["rows"] if r["amount"] > 0), ""),
        ("Otot", sum(r["amount"] for r in ba["rows"] if r["amount"] < 0), sum(r["amount"] for r in bs["rows"] if r["amount"] < 0), ""),
        ("Loppusaldo", ba["closing"], bs["closing"], "= tili 1910"),
    ]))
    story.append(Spacer(1, 3 * mm))
    bal = pack.balances("SEP")
    bal_a = pack.balances("AUG")
    notes = {"1700": "lasku 2404, avoin osa", "1760": "ALV-vähennykset 8+9 (tilitetään)", "1780": "liikaa maksettu km-korvaus", "1790": "YEL 8 + YEL 9 + puuttuva kuitti (KYSY)",
             "1800": "lokakuun vuokra + vastuuvakuutus 10/2024–9/2025", "2885": "syyskuun korttilasku (erääntyy 15.10.)", "2939": "myynnin ALV 8+9",
             "2931": "ennakonpidätys 9/2024", "2932": "sava 9/2024", "2935": "TyEL 9/2024", "2936": "TVR 9/2024", "2620": "laina"}
    rows = []
    for a in ACCOUNTS:
        if a in ("1100", "2000", "2250") or a >= "3000":
            continue
        if bal[a] or bal_a[a]:
            rows.append((f"{a} {ACCOUNTS[a]} (debet +, kredit −)", bal_a[a], bal[a], notes.get(a, "")))
    story.append(sec("TASE-ERÄT KUUN LOPUSSA (ilman kalustoa ja omaa pääomaa)", rows))
    story.append(Spacer(1, 3 * mm))
    res = []
    for m in ("AUG", "SEP"):
        mv = pack.movement(m)
        res.append(-sum(v for a, v in mv.items() if a >= "3000"))
    story.append(sec("TULOS (ennen poistoja, lomapalkkajaksotusta ja veroja)", [("Kuukauden tulos", res[0], res[1],
                                                                                "poistot ja lomapalkkavelka kirjataan tilinpäätöksessä, eivät kuulu tähän avaimeen")]))
    story.append(Spacer(1, 3 * mm))
    story.append(P("Tililuettelo: " + " · ".join(f"{a} {n}" for a, n in ACCOUNTS.items()), size=7, color=GREY))
    build_pdf(path, story, f"Kirjausohje ja vastaukset · {co['name']} 8–9/2024", pagesize=landscape(A4), margins=(12, 12, 12, 16))
