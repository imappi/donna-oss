// The rule for an owner's reply that carries files: the reply goes out ONLY
// when every file it carries has landed (uploaded AND registered). A failed
// file must fail the send visibly — never degrade into a reply with no
// document ids, which the server can only record as an empty conversation
// turn ("Still open after …" on the portal, nothing in the app). That is the
// 2026-09-04 Shopify settlement case: the upload threw, the failure was
// swallowed per file, and the owner's "send" became an empty turn.
//
// Pure: the portal hands in the per-file outcomes; this decides.

const messageOf = (error, fallback) => {
  const text = typeof error === 'string' ? error : error?.message;
  return String(text || '').trim() || fallback;
};

// results: [{ document }] for a landed file, [{ error }] for a failed one,
// in the order the files were given. Returns the documents to send when
// every file landed, else throws ONE error naming the first failure (the
// tray rows already carry each file's own message).
export const requireEveryEvidenceFile = (results = [], { fallbackMessage = 'Upload failed.' } = {}) => {
  const list = Array.isArray(results) ? results : [];
  const failures = list.filter((entry) => entry && entry.error);
  const documents = list.map((entry) => entry?.document).filter(Boolean);
  if (failures.length) {
    const error = new Error(messageOf(failures[0].error, fallbackMessage));
    error.code = 'EVIDENCE_UPLOAD_INCOMPLETE';
    error.failed_count = failures.length;
    error.landed_count = documents.length;
    throw error;
  }
  return documents;
};

// A registration response is honest only when it returns one registered
// document per document sent, in order. Anything less is a failed send.
export const requireEveryRegistration = (sent = [], registered = [], { fallbackMessage = 'Could not queue the file for reading.' } = {}) => {
  const sentList = Array.isArray(sent) ? sent : [];
  const registeredList = Array.isArray(registered) ? registered : [];
  const missing = sentList.filter((_, index) => !registeredList[index]);
  if (missing.length) {
    const error = new Error(fallbackMessage);
    error.code = 'EVIDENCE_REGISTER_INCOMPLETE';
    error.failed_count = missing.length;
    error.landed_count = sentList.length - missing.length;
    throw error;
  }
  return registeredList;
};
