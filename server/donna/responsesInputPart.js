// Responses-API input-part selection — images go to `input_image`,
// PDFs (and anything else file-shaped) to `input_file`.
//
// Why this module exists (2026-07-21 Telegram receipt incident,
// docs/donna-telegram-receipt-silence-diagnostic.md): every OpenAI
// Responses extractor built its document part as
//   { type: 'input_file', filename, file_data: dataUrl }
// unconditionally. `input_file` is the API's PDF lane; a JPEG pushed
// through it fails on every attempt, the extractor surfaces the
// failure as retryable DOCUMENT_EXTRACTION_FAILED, Inngest cycles it
// through backoff with the row parked at parse_stage='extracting',
// and the stuck-job cron flips it to STUCK at last-heartbeat + 300s —
// the "photo hangs ~8.5 min then fails" signature. Image documents
// through these lanes had never parsed.
//
// The unified (Anthropic) extractor already picks document-vs-image
// per upload (unifiedExtractor.js buildContentBlock); this is the same
// decision for the OpenAI Responses shape, in one place so no
// extractor re-implements it.
//
// Magic bytes outrank the declared mime in both directions: a PDF
// mislabeled image/* stays on the file lane, and a JPEG mislabeled
// application/pdf (what an octet-stream upload defaults to at the
// dataUrl build) still reaches the image lane.

const parseDataUrl = (dataUrl = '') => {
  const str = String(dataUrl || '');
  const comma = str.indexOf(',');
  if (!str.startsWith('data:') || comma === -1) return { mime: '', payload: '' };
  const mime = str.slice(5, comma).split(';')[0].trim().toLowerCase();
  return { mime, payload: str.slice(comma + 1) };
};

// Base64 prefixes of the magic bytes for PDF plus the image formats
// OpenAI vision accepts (jpeg / png / gif / webp). Anything else
// returns null and the declared mime decides.
const sniffMimeFromBase64 = (payload = '') => {
  if (payload.startsWith('JVBERi')) return 'application/pdf'; // %PDF
  if (payload.startsWith('/9j/')) return 'image/jpeg'; // JPEG SOI
  if (payload.startsWith('iVBORw0KGgo')) return 'image/png'; // PNG signature
  if (payload.startsWith('R0lGOD')) return 'image/gif'; // GIF87a/89a
  // RIFF container: bytes 0-3 "RIFF" alone also match WAV/AVI, so
  // require the "WEBP" tag too. Bytes 9-11 ("EBP") sit on a 3-byte
  // base64 group boundary and encode to chars 12-15 = 'RUJQ'
  // regardless of the varying size field in bytes 4-7.
  if (payload.startsWith('UklGR') && payload.slice(12, 16) === 'RUJQ') return 'image/webp';
  return null;
};

export const buildResponsesDocumentPart = ({
  dataUrl,
  filename = '',
  fallbackFilename = 'document.pdf'
} = {}) => {
  const { mime: declaredMime, payload } = parseDataUrl(dataUrl);
  const sniffedMime = sniffMimeFromBase64(payload);

  if (sniffedMime === 'application/pdf') {
    return { type: 'input_file', filename: filename || fallbackFilename, file_data: dataUrl };
  }
  if (sniffedMime) {
    return {
      type: 'input_image',
      image_url: declaredMime === sniffedMime ? dataUrl : `data:${sniffedMime};base64,${payload}`
    };
  }
  if (declaredMime.startsWith('image/')) {
    // Declared an image but the bytes don't sniff as a supported
    // format (e.g. HEIC). Send it down the image lane as declared —
    // the API's format error is the honest failure either way, and
    // it is what the pre-fix behavior produced too.
    return { type: 'input_image', image_url: dataUrl };
  }
  return { type: 'input_file', filename: filename || fallbackFilename, file_data: dataUrl };
};

// The one sniffer: the Anthropic content block reads the bytes the same way
// (documentLaneRequest.js anthropicFileBlock).
export { sniffMimeFromBase64 };
export const __sniffMimeFromBase64 = sniffMimeFromBase64;
