export const SUPPORTED_LANGUAGES = new Set([
  'en','hi','bn','ta','te','mr','gu','kn','ml','pa','ur','or','as','ne','si','my',
  'es','fr','de','it','pt','nl','ru','pl','tr','el','sv','uk',
  'ar','fa','he','sw','zh-CN','zh-TW','ja','ko','th','vi','id','ms','tl',
]);

async function translateWithOfficialApi(texts, target, source, key) {
  const res = await fetch(`https://translation.googleapis.com/language/translate/v2?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: texts, target, source, format: 'text' }),
  });
  if (!res.ok) throw new Error(`Translation API error (${res.status})`);
  const data = await res.json();
  return data.data.translations.map(t => t.translatedText);
}

async function translateOneFree(text, target, source) {
  if (!text || !text.trim()) return '';
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${source}&tl=${target}&dt=t&q=${encodeURIComponent(text)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Translation failed (${res.status})`);
  const data = await res.json();

  return (data[0] || []).map(seg => seg[0]).join('');
}

async function translateWithFreeEndpoint(texts, target, source) {
  const CONCURRENCY = 6;
  const results = new Array(texts.length);
  let cursor = 0;
  async function worker() {
    while (cursor < texts.length) {
      const idx = cursor++;
      try {
        results[idx] = await translateOneFree(texts[idx], target, source);
      } catch (e) {
        results[idx] = texts[idx]; // fall back to the original text rather than failing the whole menu
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, texts.length) }, worker));
  return results;
}

// Translates an array of strings, preserving order and empty strings. `source` defaults to English
// since that's the base language every category/item name is authored in.
export async function translateTexts(texts, target, source = 'en') {
  if (!texts.length) return [];
  const key = process.env.GOOGLE_TRANSLATE_API_KEY;
  if (key) {
    try {
      return await translateWithOfficialApi(texts, target, source, key);
    } catch (e) {
      // Fall through to the free endpoint rather than breaking translation entirely if the key/quota is bad.
    }
  }
  return translateWithFreeEndpoint(texts, target, source);
}
