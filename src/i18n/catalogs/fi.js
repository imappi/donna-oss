import fiDetails from './fiDetails.fi.js';
import pilotSetup from './pilotSetup.fi.js';
import reconciliationAuthority from './reconciliationAuthority.fi.js';
import interfaceValues from './interfaceValues.fi.js';
import ownerAccess from './ownerAccess.fi.js';
import foundation from './fi/foundation.js';
import upload from './fi/upload.js';
import documentFirm from './fi/documentFirm.js';
import transactionDetail from './fi/transactionDetail.js';
import transactionActions from './fi/transactionActions.js';
import report from './fi/report.js';
import operator from './fi/operator.js';
import feed from './fi/feed.js';
import portalOverview from './fi/portalOverview.js';
import portalEvidence from './fi/portalEvidence.js';
import portalSetup from './fi/portalSetup.js';
import portalTaxonomy from './fi/portalTaxonomy.js';
import mounted from './fi/mounted.js';

// The Finnish interface catalog. Part files mirror the Arabic split one to one
// (fiCatalog.test.js checks it), so a message has the same owner file in every
// translated locale. Machine-authored and not yet reviewed by a professional
// translator: the registry marks it alpha and its label says "early version".
// Bump the date and suffix in the same change as any message edit.
export const FI_CATALOG_VERSION = '2026-11-10.fi-alpha.8';

export const FI_CATALOG_METADATA = Object.freeze({
  locale: 'fi',
  maturity: 'alpha',
  displayLabel: 'Suomi — varhainen versio',
  authorship: 'machine-authored',
  professionalReview: false,
  sourceLocale: 'en',
  sourceCatalogVersion: '2026-09-28.sg-native-intake.1',
  catalogVersion: FI_CATALOG_VERSION,
  expectedMessageCount: 2875,
  register: 'informal second person singular (sinä); never teitittely',
  outOfScope: Object.freeze([
    'server-built text: emails, SMS, chat-channel messages, questions written by code or a model',
    'marketing and legal pages',
    'Swedish'
  ])
});

// One Finnish term per concept, used the same way in every message. `note`
// records a choice between alternatives. The PR description carries the table.
const term = (finnish, note) => Object.freeze(note ? { term: finnish, note } : { term: finnish });
export const FI_GLOSSARY = Object.freeze({
  bookkeeping: term('kirjanpito', '“books”, “bookkeeping” and “accounting” (as the records) are all kirjanpito'),
  accounting_firm: term('tilitoimisto'),
  owner: term('yrittäjä', 'the person running the client company; not “omistaja”, which reads as shareholder'),
  client_portal: term('asiakasportaali'),
  venture: term('yritys', 'the product word “venture” / “entity” for a client company'),
  workspace: term('työtila'),
  document: term('tosite', 'bookkeeping evidence; “asiakirja” only for legal or registry documents'),
  file: term('tiedosto'),
  evidence_request: term('tositepyyntö'),
  receipt: term('kuitti', 'a purchase receipt; a system record of an applied action is “vahvistus”'),
  invoice: term('lasku'),
  sales_invoice: term('myyntilasku'),
  purchase_invoice: term('ostolasku', '“supplier bill” and “bill” as well'),
  credit_note: term('hyvityslasku'),
  bank_statement: term('tiliote'),
  bank_transaction: term('tilitapahtuma'),
  reconciliation: term('täsmäytys', 'reconciling balances; matching a document to a bank line is “yhdistäminen”'),
  matching: term('yhdistäminen', 'document ↔ transaction; kept apart from täsmäytys'),
  coding: term('tiliöinti', 'assigning accounts; “re-code” is tiliöidä uudelleen'),
  posting: term('kirjaus', 'post → kirjata, posted → kirjattu'),
  journal: term('päiväkirja', 'a single entry is “kirjaus”'),
  general_ledger: term('pääkirja'),
  chart_of_accounts: term('tilikartta'),
  account: term('tili'),
  debit_credit: term('debet / kredit'),
  vat: term('ALV', '“arvonlisävero” only where spelled out'),
  input_output_vat: term('ostojen ALV / myynnin ALV'),
  vat_return: term('kausiveroilmoitus', 'the official name of the Finnish return; other countries’ returns are “ALV-ilmoitus”'),
  reverse_charge: term('käännetty verovelvollisuus', 'official'),
  fiscal_year: term('tilikausi'),
  period: term('kausi', 'a month or quarter of the books; close → päättää kausi'),
  balance_sheet: term('tase'),
  income_statement: term('tuloslaskelma'),
  trial_balance: term('saldoluettelo', 'chosen over “saldolista”'),
  financial_statements: term('tilinpäätös', 'the statutory annual statements; monthly views are “raportit”'),
  business_id: term('Y-tunnus'),
  sole_trader: term('toiminimi', '“yksityinen elinkeinonharjoittaja” only where legal precision needs it'),
  limited_company: term('osakeyhtiö', 'Oy in names'),
  payroll: term('palkat', 'palkanlaskenta for the process; payslip → palkkalaskelma'),
  upload: term('lähettää', 'not “ladata”, which is kept for download so the direction is never ambiguous'),
  download: term('ladata'),
  question: term('kysymys'),
  review: term('tarkistaa / tarkistus'),
  approve: term('hyväksyä'),
  confirm: term('vahvistaa'),
  draft: term('luonnos'),
  setup: term('käyttöönotto'),
  connect: term('yhdistää / yhteys'),
  sign_in: term('kirjautua sisään'),
  operator: term('ylläpitäjä', 'Donna’s runtime operator, an internal role'),
  provider: term('palveluntarjoaja'),
  audit_trail: term('kirjausketju', 'the trail behind a posting; a system access log is “tarkastusloki”'),
  accrual_cash_basis: term('suoriteperuste / maksuperuste'),
  management_books: term('sisäinen kirjanpito', 'chosen over “johdon kirjanpito”'),
  statutory_books: term('lakisääteinen kirjanpito'),
  suspense_account: term('selvittelytili'),
  directors_loan: term('osakaslaina'),
  drawings: term('yksityisotot'),
  expense_claim: term('kulukorvaus'),
  legal_form: term('yhtiömuoto'),
  accountant: term('kirjanpitäjä'),
  snooze: term('lykätä', 'not “torkuttaa”'),
  secretarial: term('yhtiöhallinto'),
  standing_authority: term('pysyvä valtuutus', 'one grant; the screen and the concept are “pysyvät valtuudet”'),
  materiality_threshold: term('olennaisuusraja'),
  supplier: term('toimittaja'),
  opening_balance: term('alkusaldo')
});

const fi = Object.freeze({
  "operator.providerFailure.operatorAction": "Tarkista palveluntarjoajan määritykset ja hylätty pyyntö.",
  "operator.providerFailure.recovery.recovery_failed": "Myöhempi palautusyritys epäonnistui muusta syystä; kirjattua palveluntarjoajan virhettä ei ole poistettu.",
  "operator.providerFailure.customer.title": "Kestää tavallista kauemmin",
  "operator.providerFailure.customer.body": "Tallennettu — tämä vaihe kestää tavallista kauemmin. Asia on kirjattu tukea varten, eikä sinun tarvitse tehdä mitään.",
  "operator.providerFailure.customer.reference": "Viite",
  "operator.providerFailure.customer.stale": "Uusinta tilaa ei voitu ladata. Näytetään viimeksi ladatut tiedot.",
  "operator.providerFailure.title": "Palveluntarjoajien virheet",
  "operator.providerFailure.refresh": "Päivitä tila",
  "operator.providerFailure.stale": "Tilan päivitys epäonnistui. Alla olevat vahvistukset ovat viimeksi ladatusta tilasta.",
  "operator.providerFailure.loading": "Ladataan palveluntarjoajien vahvistuksia…",
  "operator.providerFailure.unavailable": "Palveluntarjoajan tila ei ole saatavilla.",
  "operator.providerFailure.empty": "Ei aktiivisia palveluntarjoajan virhevahvistuksia.",
  "operator.providerFailure.operator": "Vaatii ylläpitäjän toimia",
  "operator.providerFailure.queue": "Lisää palautus jonoon",
  "operator.providerFailure.credentialAction": "Korjaa palveluntarjoajalle määritetyt tunnistetiedot.",
  "operator.providerFailure.lane.matching": "Tositteiden yhdistäminen",
  "operator.providerFailure.lane.coding": "Tapahtumien tiliöinti",
  "operator.providerFailure.lane.ask_draft": "Kysymysluonnos asiakkaalle",
  "operator.providerFailure.cause.PROVIDER_KEY_MISSING": "Palveluntarjoajan avainta ei ole määritetty.",
  "operator.providerFailure.cause.PROVIDER_UNAUTHORIZED": "Palveluntarjoaja hylkäsi määritetyt tunnistetiedot.",
  "operator.providerFailure.cause.PROVIDER_RATE_LIMITED": "Palveluntarjoajan pyyntöraja täyttyi.",
  "operator.providerFailure.cause.PROVIDER_UNAVAILABLE": "Palveluntarjoajan palvelu ei ole saatavilla.",
  "operator.providerFailure.cause.PROVIDER_REJECTED_REQUEST": "Palveluntarjoaja hylkäsi pyynnön.",
  "operator.providerFailure.cause.PROVIDER_TIMEOUT": "Palveluntarjoajan toiminto ylitti aikarajansa.",
  "operator.providerFailure.cause.PROVIDER_TIMEOUT.execution_budget_insufficient": "Ei aloitettu: työllä ei ollut tähän vaiheeseen riittävästi aikaa jäljellä. Seuraava ajo jatkaa sitä.",
  "operator.providerFailure.cause.PROVIDER_NETWORK": "Yhteys palveluntarjoajaan epäonnistui.",
  "operator.providerFailure.cause.PROVIDER_INVALID_OUTPUT": "Palveluntarjoaja palautti vastauksen, jota ei voitu lukea.",
  "operator.providerFailure.cause.unknown": "Palveluntarjoajan virhe kirjattiin.",
  "operator.providerFailure.recovery.awaiting_retry": "Odotetaan nykyisen taustaprosessin seuraavaa uudelleenyrityksen tarkistusta.",
  "operator.providerFailure.recovery.retry_in_progress": "Uudelleenyritys on käynnissä; palautumista ei ole vielä vahvistettu.",
  "operator.providerFailure.recovery.retry_pending": "Palautuspyyntö on jonossa.",
  "operator.providerFailure.recovery.recovery_wait": "Uudelleenyritykset päättyivät; odotetaan nykyistä palautustarkistusta.",
  "operator.providerFailure.attempts": "Epäonnistuneet ajot: {count}",
  "operator.providerFailure.queueAttempts": "Jonotusyritykset: {count}",
  "portal.inspection.region": "Kirjanpidon tarkastelu",
  "portal.inspection.title": "Päiväkirja ja ALV",
  "portal.inspection.help": "Tarkastele raporttiesi taustalla olevia kirjauksia. Jos jokin pitää korjata, kysy Donnalta tositteesta tai tapahtumasta.",
  "portal.inspection.month": "Kuukausi",
  "portal.inspection.refresh": "Päivitä tulokset",
  "portal.inspection.loading": "Ladataan päiväkirjaa…",
  "portal.inspection.empty": "Tälle kuukaudelle ei ole kirjauksia.",
  "portal.inspection.account": "Tili",
  "portal.inspection.debit": "Debet",
  "portal.inspection.credit": "Kredit",
  "portal.inspection.taxCode": "ALV-koodi",
  "portal.inspection.alvHelp": "ALV-esikatselu kirjatuista vienneistä. Esikatselu ei lähetä ilmoitusta.",
  "portal.inspection.alvLoading": "Ladataan ALV-tietoja…",
  "portal.inspection.journalError": "Päiväkirjan tiedot eivät ole saatavilla. Päivitä ja yritä uudelleen.",
  "portal.inspection.alvError": "ALV-tiedot eivät ole saatavilla. Päivitä ja yritä uudelleen.",
  "portal.inspection.monthRequired": "Valitse kelvollinen kuukausi.",

  ...fiDetails,
  ...pilotSetup,
  ...reconciliationAuthority,
  ...interfaceValues,
  ...ownerAccess,
  ...foundation,
  ...upload,
  ...documentFirm,
  ...transactionDetail,
  ...transactionActions,
  ...report,
  ...operator,
  ...feed,
  ...portalOverview,
  ...portalEvidence,
  ...portalSetup,
  ...portalTaxonomy,
  ...mounted
});

export default fi;
