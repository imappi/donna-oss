// The text of the replay demo's notice (src/components/DemoReplayNotice.jsx),
// from the health route: `provider_replay` is the stored record that this book
// was given recorded model outputs (migration 205, never deleted), and
// `model_lanes.replay` says whether the running process serves recordings now.
// A book once produced by replay keeps the notice for good; when a later start
// runs it on live providers, the notice says the earlier answers were recorded
// and that new work goes to the providers configured now.

export const describeRecordedModels = (models) =>
  Object.values(models || {}).flat().filter(Boolean).join(', ');

const TEXT = Object.freeze({
  en: Object.freeze({
    title: 'Demo: recorded model outputs',
    replaying: (models, at) => `This book was read, coded and matched from answers recorded earlier (${models}, recorded ${at}). No model is called and no key is used.`,
    live: (models, at) => `This book holds answers recorded earlier for the demo (${models}, recorded ${at}); they are marked "+replayed". New work on it is answered by the providers configured now.`
  }),
  fi: Object.freeze({
    title: 'Demo: recorded model outputs · tallennetut mallivastaukset',
    replaying: (models, at) => `Tämä kirjanpito on luettu, kirjattu ja täsmäytetty aiemmin tallennetuista vastauksista (${models}, tallennettu ${at}). Mallia ei kutsuta eikä avainta käytetä.`,
    live: (models, at) => `Tässä kirjanpidossa on demoa varten tallennettuja vastauksia (${models}, tallennettu ${at}); ne on merkitty "+replayed". Uudet tehtävät hoitavat nyt määritetyt palveluntarjoajat.`
  })
});

// null when the book has no replay record (a normal book: no notice).
export const demoReplayNoticeText = ({ health, locale = 'en' } = {}) => {
  const session = health?.provider_replay;
  if (!session) return null;
  const text = String(locale || '').startsWith('fi') ? TEXT.fi : TEXT.en;
  const models = describeRecordedModels(session.recorded_models) || '—';
  const at = session.recorded_at || '—';
  const replaying = health?.model_lanes?.replay === true;
  return { title: text.title, body: replaying ? text.replaying(models, at) : text.live(models, at), replaying };
};
