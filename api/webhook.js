// Vinted Photo Search Bot — Telegram webhook (Vercel serverless function)
// Фото → безкоштовний AI (Groq) детально розбирає річ або весь образ → пошук на Vinted →
// фільтр за ознаками → візуальна перевірка кожного оголошення → тільки справді схожі результати

// waitUntil дозволяє відповісти Telegram одразу і продовжити роботу у фоні (Vercel ставить пакет сам)
let waitUntil = null;
try {
  ({ waitUntil } = await import('@vercel/functions'));
} catch {
  waitUntil = null; // локальний запуск без пакета — просто дочекаємось завершення
}

// ---------- Налаштування ----------
// Прибираємо пробіли, лапки й випадковий префікс "bot", щоб токен з Vercel завжди був чистим
const BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim().replace(/^['"]|['"]$/g, '').replace(/^bot/i, '');
if (!BOT_TOKEN) console.error('TELEGRAM_BOT_TOKEN не задано у Vercel → Settings → Environment Variables');
const TG = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TG_FILE = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
const DOMAIN = process.env.VINTED_DOMAIN || 'www.vinted.de';
const MODEL = process.env.GROQ_MODEL || 'qwen/qwen3.8-27b';

const ITEM = { results: 6, pool: 16, check: 12 }; // одна річ: показати / зібрати кандидатів / перевірити візуально
const OUTFIT = { maxPieces: 10, results: 3, pool: 10, check: 6 }; // аутфіт: на кожну річ
const MIN_MATCH = 6; // мінімальна візуальна схожість (з 10), щоб показати як збіг
const MAX_AI_PHOTOS = 3; // ліміт моделі Groq на кількість фото в одному запиті
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Простий обмежувач паралельності, щоб не впертись у ліміти Groq і Vinted
function limiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn()
      .then(resolve, reject)
      .finally(() => {
        active--;
        next();
      });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}
const aiLimit = limiter(4);
const vintedLimit = limiter(3);

// ---------- Telegram ----------
async function tg(method, body) {
  const r = await fetch(`${TG}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!data.ok) console.error(`TG ${method} failed:`, data.description);
  return data;
}

const esc = (s = '') => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const searchUrl = (q, priceMax) => {
  const u = new URL(`https://${DOMAIN}/catalog`);
  u.searchParams.set('search_text', q);
  if (priceMax) u.searchParams.set('price_to', String(priceMax));
  return u.toString();
};

async function downloadTelegramFile(fileId) {
  const info = await tg('getFile', { file_id: fileId });
  if (!info.ok) throw new Error('Не вдалося отримати файл з Telegram');
  const r = await fetch(`${TG_FILE}/${info.result.file_path}`);
  const buf = Buffer.from(await r.arrayBuffer());
  return buf.toString('base64');
}

// Довгий текст ділимо на кілька повідомлень по блоках (ліміт Telegram — 4096 символів)
async function sendLong(chatId, blocks, replyMarkup) {
  const chunks = [];
  let cur = '';
  for (const b of blocks) {
    if (cur && (cur + '\n\n' + b).length > 3900) {
      chunks.push(cur);
      cur = b;
    } else cur = cur ? `${cur}\n\n${b}` : b;
  }
  if (cur) chunks.push(cur);
  for (let i = 0; i < chunks.length; i++) {
    await tg('sendMessage', {
      chat_id: chatId,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      text: chunks[i],
      ...(i === chunks.length - 1 && replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  }
}

const imgPart = (img) => ({ type: 'image_url', image_url: { url: `data:${img.mediaType};base64,${img.base64}` } });

// ---------- AI (Groq) ----------
async function askJSON(content, maxTokens = 3000) {
  return aiLimit(async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: maxTokens,
          temperature: 0.1,
          messages: [{ role: 'user', content }],
        }),
      });
      const data = await r.json().catch(() => ({}));
      // Ліміт безкоштовного тарифу або тимчасова помилка → чекаємо і пробуємо ще
      if (r.status === 429 || r.status >= 500) {
        const wait = Math.min(Number(r.headers.get?.('retry-after')) * 1000 || 1500 * 2 ** attempt, 10000);
        console.warn(`Groq ${r.status}, повтор через ${wait} мс`);
        await sleep(wait);
        continue;
      }
      if (!r.ok) throw new Error(`Groq API: ${data?.error?.message || r.status}`);
      const text = (data.choices?.[0]?.message?.content || '')
        .replace(/<think>[\s\S]*?<\/think>/g, '')
        .replace(/```(?:json)?/g, '');
      const json = text.match(/\{[\s\S]*\}/);
      if (!json) throw new Error('AI не повернув JSON');
      return JSON.parse(json[0]);
    }
    throw new Error('Groq перевантажений, спробуй за хвилину');
  });
}

// Страховка: відкидаємо запити з кирилицею, лишаємо тільки DE/EN
const cleanQueries = (qs, max = 4) => [
  ...new Set(
    (qs || [])
      .map((q) => String(q || '').replace(/\s+/g, ' ').trim())
      .filter((q) => q && q.length <= 80 && !/[Ѐ-ӿ]/.test(q)),
  ),
].slice(0, max);

// ---------- Промпти ----------
const VOCAB = `Німецький словник для запитів (використовуй точні терміни):
- візерунки: kariert / Karo (клітинка), Glencheck, Hahnentritt (гусяча лапка), Tartan, gestreift / Streifen (смужка), Nadelstreifen, gepunktet (горох), geblümt (квіти), Leoprint, Camouflage, Paisley, uni / einfarbig (однотонний), Print / Aufdruck (принт), Logo
- матеріали: Cord (вельвет, рубчик), Denim / Jeans, Leder, Kunstleder, Wildleder (замша), Strick (вʼязане), Grobstrick, Wolle, Kaschmir, Fleece, Teddy, Flanell, Leinen, Seide, Satin, Samt, Nylon, Daunen (пух), Steppjacke (стьобана)
- крій: oversize, slim fit, regular, cropped, high waist, wide leg, straight, bootcut, Mom/Baggy, Rollkragen (гольф), V-Ausschnitt, Kapuze (капюшон), Reißverschluss (блискавка), Knopfleiste
- для кого: Herren, Damen, Kinder, Unisex`;

const ITEM_FIELDS = `"name_uk": "точна назва речі українською з візерунком, матеріалом і кольором (до 8 слів)",
    "attributes": {
      "category": "тип речі (напр. сорочка, худі, джинси, кросівки, сумка, окуляри)",
      "gender": "Herren | Damen | Unisex | Kinder",
      "pattern": "візерунок",
      "material": "матеріал/фактура",
      "colors": "кольори, від основного",
      "fit": "крій/посадка/довжина",
      "details": "найпомітніші деталі: комір, ґудзики, кишені, блискавка, підошва, фурнітура",
      "logo_text": "видимий логотип або напис, інакше null",
      "brand": "бренд або null",
      "brand_confidence": число 0–1
    },
    "queries": ["DE точний", "DE без бренду", "DE ширший/синонім", "EN"],
    "must_have": [["синоніми типу речі"], ["синоніми візерунку або матеріалу"]],
    "must_not": ["корені схожих, але ІНШИХ речей"]`;

const QUERY_RULES = `Правила для queries (4 запити):
- ТІЛЬКИ німецькою або англійською, жодної кирилиці
- 1-й: найточніший німецькою — (бренд, якщо brand_confidence ≥ 0.7) + (Herren/Damen, якщо очевидно) + тип + візерунок/матеріал + колір
- 2-й: німецькою без бренду — тип + візерунок/матеріал + колір (+ ключовий крій)
- 3-й: німецькою ширше — синонім або побутова назва (напр. Holzfällerhemd, Karohemd, Flanellhemd; Strickjacke ↔ Cardigan)
- 4-й: англійською — те саме, що 1-й/2-й
- КОЖЕН запит містить головну відмінну ознаку (візерунок і/або матеріал), якщо вона є. Не плутай: клітинку з вельветом, смужку з клітинкою, денім з бавовною, шкіру з кожзамом, вʼязане з флісом
- 2–6 слів, без зайвих прикметників ("schön", "trendy"); ціну не додавай`;

const FILTER_RULES = `Правила для must_have / must_not (ними перевіряються назви оголошень):
- must_have: 1–3 групи синонімів; кожна група — ключова ознака (тип речі; візерунок або матеріал). Короткі слова/корені в нижньому регістрі, німецькою І англійською. Напр. клітчаста сорочка: [["hemd","shirt","bluse","overshirt"],["karo","kariert","check","plaid","tartan","flanell","holzfall"]]
- must_not: корені речей, які легко сплутати, але це ІНША річ. Напр. клітчаста сорочка: ["cord","corduroy","jeans","denim","gestreift","stripe"]
- не додавай у must_not кольори і слова, які можуть бути в назві правильної речі`;

const ITEM_PROMPT = (caption) => `Ти експерт з одягу та ресейлу. Знайди на Vinted МАКСИМАЛЬНО схожу річ до тієї, що на фото.
Спершу уважно розглянь річ: тип, візерунок, матеріал і фактуру (рубчик = Cord, клітинка = Karo), кольори, крій, деталі, логотипи й написи. Тільки потім складай запити.
Якщо на фото кілька речей — обери головну (по центру / найбільшу), або ту, про яку пише користувач.
${caption ? `Побажання користувача (важливіші за фото): "${caption}"` : ''}

Поверни ТІЛЬКИ JSON:
{
  ${ITEM_FIELDS},
  "price_max": число в євро, якщо користувач вказав максимальну ціну, інакше null
}

${VOCAB}

${QUERY_RULES}

${FILTER_RULES}`;

const TEXT_PROMPT = (text) => `Ти допомагаєш знайти речі на Vinted. Користувач написав, що шукає (може бути будь-якою мовою):
"${text}"
Переклади й перетвори це на точні пошукові запити. Невідомі атрибути — null.

Поверни ТІЛЬКИ JSON:
{
  ${ITEM_FIELDS},
  "price_max": число в євро, якщо користувач вказав максимальну ціну, інакше null
}

${VOCAB}

${QUERY_RULES}

${FILTER_RULES}`;

const OUTFIT_PROMPT = (caption, count) => `Ти стиліст і експерт з ресейлу. Знайди на фото ВСІ речі, які можна купити на Vinted, щоб повторити цей образ.
${count > 1 ? `Ось ${count} фото — це ОДИН образ (різні ракурси або окремі речі). Якщо та сама річ є на кількох фото — вкажи її один раз.` : ''}

Фото може бути БУДЬ-ЯКИМ: людина на повний зріст, по пояс, по груди, селфі, дзеркальне селфі, крупний план, фото ззаду, кілька людей, речі на вішаку / ліжку / підлозі (flat lay), скриншот з соцмереж. Не відмовляйся і не чекай повного зросту — розбери все, що видно.
Включай навіть речі, які видно лише частково (комір з-під светра, край сумки, частина взуття) — познач це у visibility.
Шукай: верхній одяг, піджаки, светри, худі, сорочки, футболки, топи, сукні, спідниці, штани, джинси, шорти, взуття, сумки, рюкзаки, головні убори, шарфи, рукавиці, ремені, окуляри, годинники, прикраси, шкарпетки/колготи, якщо помітні.
Якщо людей кілька — розбери речі всіх, у name_uk вкажи, чия (напр. «(ліворуч)»).
Максимум ${OUTFIT.maxPieces} речей, від найпомітнішої. Не вигадуй речі, яких не видно.
${caption ? `Побажання користувача (важливіші за фото): "${caption}"` : ''}

Поверни ТІЛЬКИ JSON:
{
  "style_uk": "стиль образу українською (до 8 слів)",
  "price_max": число в євро, якщо користувач вказав бюджет на ОДНУ річ, інакше null,
  "items": [
    {
      "emoji": "один емодзі",
      "photo": номер фото (1–${Math.max(count, 1)}), де річ видно найкраще,
      "visibility": "повністю | частково | ледь видно",
      ${ITEM_FIELDS}
    }
  ]
}

${VOCAB}

${QUERY_RULES}

${FILTER_RULES}`;

// ---------- Розбір ----------
function normalizePiece(p) {
  const queries = cleanQueries(p.queries);
  if (!queries.length) return null;
  return {
    ...p,
    queries,
    name_uk: p.name_uk || p.attributes?.category || 'річ',
    attributes: p.attributes || {},
  };
}

async function analyzeItem(images, caption) {
  const parsed = await askJSON([{ type: 'text', text: ITEM_PROMPT(caption) }, ...images.map(imgPart)]);
  const piece = normalizePiece(parsed);
  if (!piece) throw new Error('AI не зміг розпізнати річ');
  return { ...piece, price_max: parsed.price_max || null };
}

async function analyzeText(text) {
  const parsed = await askJSON(TEXT_PROMPT(text));
  const piece = normalizePiece(parsed);
  if (!piece) throw new Error('AI не зміг скласти запит');
  return { ...piece, price_max: parsed.price_max || null };
}

async function analyzeOutfit(images, caption) {
  const parsed = await askJSON(
    [{ type: 'text', text: OUTFIT_PROMPT(caption, images.length) }, ...images.map(imgPart)],
    6000,
  );
  const pieces = (parsed.items || []).map(normalizePiece).filter(Boolean).slice(0, OUTFIT.maxPieces);
  if (!pieces.length) throw new Error('AI не знайшов речей на фото');
  return { style_uk: parsed.style_uk || 'образ', price_max: parsed.price_max || null, pieces };
}

function attrLine(a = {}) {
  const parts = [a.category, a.pattern, a.material, a.colors, a.fit, a.details, a.gender];
  if (a.brand && (a.brand_confidence ?? 0) >= 0.6) parts.push(`бренд: ${a.brand}`);
  if (a.logo_text) parts.push(`напис: ${a.logo_text}`);
  return parts.filter((x) => x && !['null', '—', '-', 'невідомо', 'немає'].includes(String(x).trim().toLowerCase())).join(' · ');
}

// ---------- Vinted ----------
let vintedCookie = null;
let cookieAt = 0;

function readSetCookies(headers) {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const raw = headers.get('set-cookie');
  return raw ? raw.split(/,(?=\s*[^;=\s]+=)/) : [];
}

async function getVintedCookie(force = false) {
  if (vintedCookie && !force && Date.now() - cookieAt < 30 * 60 * 1000) return vintedCookie;
  const r = await fetch(`https://${DOMAIN}/`, {
    headers: { 'user-agent': UA, 'accept-language': 'de-DE,de;q=0.9,en;q=0.8', accept: 'text/html' },
  });
  vintedCookie = readSetCookies(r.headers)
    .map((c) => c.split(';')[0].trim())
    .filter(Boolean)
    .join('; ');
  cookieAt = Date.now();
  return vintedCookie;
}

async function searchVinted(query, priceMax, retry = true) {
  const res = await vintedLimit(async () => {
    const url = new URL(`https://${DOMAIN}/api/v2/catalog/items`);
    url.searchParams.set('search_text', query);
    url.searchParams.set('per_page', '48');
    url.searchParams.set('page', '1');
    url.searchParams.set('order', 'relevance');
    if (priceMax) url.searchParams.set('price_to', String(priceMax));

    const cookie = await getVintedCookie(!retry);
    const r = await fetch(url, {
      headers: {
        'user-agent': UA,
        accept: 'application/json, text/plain, */*',
        'accept-language': 'de-DE,de;q=0.9',
        referer: `https://${DOMAIN}/catalog`,
        cookie,
      },
    });
    if ((r.status === 401 || r.status === 403) && retry) return { retry: true };
    if (!r.ok) throw new Error(`Vinted відповів ${r.status}`);
    const data = await r.json();
    return { items: (data.items || []).map(normalizeItem) };
  });
  return res.retry ? searchVinted(query, priceMax, false) : res.items;
}

const CUR = { EUR: '€', PLN: 'zł', CZK: 'Kč', GBP: '£', SEK: 'kr', USD: '$' };

function normalizeItem(it) {
  let price = '';
  if (it.price && typeof it.price === 'object') {
    price = `${Number(it.price.amount).toFixed(2).replace('.', ',')} ${CUR[it.price.currency_code] || it.price.currency_code}`;
  } else if (it.price) {
    price = `${it.price} ${CUR[it.currency] || it.currency || '€'}`;
  }
  return {
    id: it.id,
    title: it.title || 'Без назви',
    price,
    amount: Number(typeof it.price === 'object' ? it.price?.amount : it.price) || 0,
    brand: it.brand_title || '',
    size: it.size_title || '',
    url: it.url || `https://${DOMAIN}/items/${it.id}`,
    photo: it.photo?.url || it.photo?.full_size_url || null,
  };
}

// ---------- Точність: фільтр за ознаками ----------
const norm = (t = '') =>
  String(t).toLowerCase().replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ü/g, 'u').replace(/ß/g, 'ss');
const cleanWords = (arr) => (Array.isArray(arr) ? arr : []).map((w) => norm(w).trim()).filter((w) => w.length >= 3);

function keywordScore(item, mustHave, mustNot, brand) {
  const text = norm(`${item.title} ${item.brand}`);
  if (mustNot.some((w) => text.includes(w))) return null; // явно інша річ
  let score = 0;
  for (const group of mustHave) if (group.some((w) => text.includes(w))) score += 10;
  if (brand && norm(item.brand).includes(norm(brand))) score += 5;
  return score;
}

// Збираємо кандидатів з усіх запитів, викидаємо явно інші речі, сортуємо за збігом ознак
async function findCandidates(piece, priceMax, pool) {
  const mustHave = (piece.must_have || []).map(cleanWords).filter((g) => g.length).slice(0, 3);
  const mustNot = cleanWords(piece.must_not);
  const brand = (piece.attributes?.brand_confidence ?? 0) >= 0.7 ? piece.attributes.brand : null;
  const full = mustHave.length * 10;
  const seen = new Set();
  const all = [];
  let errors = 0;

  for (const [qi, q] of piece.queries.entries()) {
    let items;
    try {
      items = await searchVinted(q, priceMax);
    } catch (e) {
      errors++;
      console.error('Vinted search error:', e.message);
      continue;
    }
    items.forEach((it, pos) => {
      if (seen.has(it.id)) return;
      seen.add(it.id);
      const kw = keywordScore(it, mustHave, mustNot, brand);
      if (kw === null) return;
      // бонус за точніший запит і вищу позицію у видачі Vinted
      it.score = kw + (piece.queries.length - qi) + (48 - pos) / 48;
      it.fullMatch = kw >= full;
      all.push(it);
    });
    if (all.filter((x) => x.fullMatch).length >= pool) break;
  }
  if (!all.length && errors) throw new Error('Vinted недоступний');
  return all.sort((a, b) => b.score - a.score).slice(0, pool);
}

// ---------- Точність: візуальна перевірка ----------
// Groq приймає до 3 фото → оригінал + 2 оголошення за один запит
async function judgePair(original, piece, pair, inOutfit) {
  const who = inOutfit
    ? `Перше фото — образ; порівнюй лише ОДНУ річ з нього: «${piece.name_uk}». Решту речей на першому фото ігноруй.`
    : 'Перше фото — річ, яку шукає користувач.';
  const parsed = await askJSON(
    [
      {
        type: 'text',
        text: `${who}
Опис цієї речі: ${attrLine(piece.attributes) || piece.name_uk}.
Далі ${pair.length} фото оголошень з Vinted. Оціни кожне за шкалою (сума = бал з 10):
- тип речі збігається: 0–4
- візерунок і матеріал/фактура збігаються: 0–3 (інший візерунок або матеріал, напр. вельвет замість клітинки → 0)
- колір збігається: 0–2
- крій і деталі схожі: 0–1
Якщо на фото оголошення зовсім інша річ — 0. Будь суворим.
Поверни ТІЛЬКИ JSON: {"scores": [${pair.map(() => 'число').join(', ')}]}`,
      },
      imgPart(original),
      ...pair.map((it) => ({ type: 'image_url', image_url: { url: it.photo } })),
    ],
    1500,
  );
  return pair.map((_, i) => Number(parsed.scores?.[i]));
}

async function verifyVisually(original, piece, candidates, { keep, check, inOutfit = false }) {
  const toCheck = candidates.filter((c) => c.photo).slice(0, check);
  const pairs = [];
  for (let i = 0; i < toCheck.length; i += 2) pairs.push(toCheck.slice(i, i + 2));
  const results = await Promise.allSettled(pairs.map((p) => judgePair(original, piece, p, inOutfit)));
  let checked = 0;
  results.forEach((r, i) => {
    if (r.status !== 'fulfilled') return console.error('Verify error:', r.reason?.message);
    pairs[i].forEach((it, j) => {
      const v = r.value[j];
      if (Number.isFinite(v)) {
        it.match = Math.max(0, Math.min(10, v));
        checked++;
      }
    });
  });
  // Перевірка не вдалась (ліміт AI) — віддаємо рейтинг за ознаками, без відсотків
  if (!checked) return { items: candidates.slice(0, keep), near: [], verified: false };
  const ranked = toCheck
    .filter((c) => Number.isFinite(c.match))
    .sort((a, b) => b.match - a.match || b.score - a.score);
  const good = ranked.filter((c) => c.match >= MIN_MATCH).slice(0, keep);
  // Нема точних збігів → покажемо найближчі (≥4), чесно позначені як «схожі»
  const near = good.length ? [] : ranked.filter((c) => c.match >= 4).slice(0, 2);
  return { items: good, near, verified: true };
}

const matchTag = (it) => (Number.isFinite(it.match) ? `${Math.round(it.match * 10)}%` : '');

// ---------- Одна річ ----------
const QUERY_BTNS = (queries, priceMax) => queries.map((q) => [{ text: `🔎 ${q}`, url: searchUrl(q, priceMax) }]);

async function runItem(chatId, statusId, piece, original) {
  const setStatus = (text) => statusId && tg('editMessageText', { chat_id: chatId, message_id: statusId, text });
  const head = `🧥 <b>${esc(piece.name_uk)}</b>${piece.price_max ? ` · до ${piece.price_max}€` : ''}`;
  const analysis = attrLine(piece.attributes);
  const analysisLine = analysis ? `🔬 <i>${esc(analysis)}</i>` : '';
  const buttons = { inline_keyboard: QUERY_BTNS(piece.queries, piece.price_max) };

  let result;
  try {
    const candidates = await findCandidates(piece, piece.price_max, ITEM.pool);
    if (original && candidates.length) {
      const n = Math.min(candidates.filter((c) => c.photo).length, ITEM.check);
      await setStatus(`👀 Це ${piece.name_uk}.\n🧐 Порівнюю ${n} оголошень з твоїм фото…`);
      result = await verifyVisually(original, piece, candidates, { keep: ITEM.results, check: ITEM.check });
    } else {
      result = { items: candidates.slice(0, ITEM.results), near: [], verified: false };
    }
  } catch (e) {
    console.error('Search error:', e.message);
    if (statusId) await tg('deleteMessage', { chat_id: chatId, message_id: statusId });
    return sendLong(chatId, [head, analysisLine, 'Vinted зараз не віддав результати напряму. Відкрий пошук за кнопками 👇'].filter(Boolean), buttons);
  }
  if (statusId) await tg('deleteMessage', { chat_id: chatId, message_id: statusId });

  const shown = result.items.length ? result.items : result.near;
  if (!shown.length) {
    return sendLong(
      chatId,
      [head, analysisLine, 'Точних збігів не знайшлося — я відсіяв усі оголошення, які не схожі на твою річ. Спробуй пошук за кнопками 👇'].filter(Boolean),
      buttons,
    );
  }

  const withPhoto = shown.filter((i) => i.photo);
  if (withPhoto.length >= 2) {
    await tg('sendMediaGroup', {
      chat_id: chatId,
      media: withPhoto.slice(0, 10).map((it) => ({
        type: 'photo',
        media: it.photo,
        caption: `${shown.indexOf(it) + 1}. ${it.title}\n${[matchTag(it) && `схожість ${matchTag(it)}`, it.price, it.size].filter(Boolean).join(' · ')}`,
      })),
    });
  }

  const list = shown.map(
    (it, i) =>
      `${i + 1}. <a href="${esc(it.url)}">${esc(it.title)}</a>\n   💶 <b>${esc(it.price)}</b>${it.brand ? ` · ${esc(it.brand)}` : ''}${it.size ? ` · ${esc(it.size)}` : ''}${matchTag(it) ? ` · 🎯 ${matchTag(it)}` : ''}`,
  );
  const note = result.items.length
    ? result.verified
      ? '✅ Кожне оголошення перевірене по фото.'
      : original
        ? '⚠️ Візуальну перевірку зараз не вдалося зробити — відсортовано за описом.'
        : '🔤 Відсортовано за збігом з описом.'
    : '≈ Точних збігів немає, ось найближчі за виглядом.';
  return sendLong(chatId, [head, analysisLine, ...list, `${note}\nБільше — за кнопками 👇`].filter(Boolean), buttons);
}

// ---------- Аутфіт ----------
async function runOutfit(chatId, statusId, fileIds, caption, extraNote = '') {
  const setStatus = (text) => tg('editMessageText', { chat_id: chatId, message_id: statusId, text });
  let outfit;
  const images = [];
  try {
    for (const id of fileIds.slice(0, MAX_AI_PHOTOS)) images.push({ base64: await downloadTelegramFile(id), mediaType: 'image/jpeg' });
    outfit = await analyzeOutfit(images, caption);
  } catch (e) {
    console.error('Outfit analyze error:', e.message);
    return setStatus('😕 Не вдалося розібрати фото. Спробуй ще раз або надішли фото чіткіше/світліше.');
  }

  const partial = (p) => p.visibility && !/повн/i.test(p.visibility);
  const list = outfit.pieces.map((p) => `${p.emoji || '•'} ${p.name_uk}${partial(p) ? ` (${p.visibility})` : ''}`).join('\n');
  await setStatus(`👗 ${outfit.style_uk}\n\nЗнайшов на фото речей: ${outfit.pieces.length}\n${list}\n\n🔎 Шукаю кожну на Vinted і перевіряю по фото…${extraNote}`);

  let blocked = false;
  const results = await Promise.all(
    outfit.pieces.map(async (piece) => {
      try {
        const candidates = await findCandidates(piece, outfit.price_max, OUTFIT.pool);
        const idx = Math.min(Math.max((Number(piece.photo) || 1) - 1, 0), images.length - 1);
        const r = await verifyVisually(images[idx], piece, candidates, { keep: OUTFIT.results, check: OUTFIT.check, inOutfit: true });
        return { piece, ...r };
      } catch (e) {
        console.error('Outfit search error:', e.message);
        blocked = true;
        return { piece, items: [], near: [] };
      }
    }),
  );

  await tg('deleteMessage', { chat_id: chatId, message_id: statusId });

  // Альбом: найкращий збіг для кожної речі
  const best = results.map((r) => ({ piece: r.piece, it: r.items[0] || r.near[0] })).filter((x) => x.it?.photo);
  if (best.length >= 2) {
    await tg('sendMediaGroup', {
      chat_id: chatId,
      media: best.slice(0, 10).map(({ piece, it }) => ({
        type: 'photo',
        media: it.photo,
        caption: `${piece.emoji || ''} ${piece.name_uk}\n${it.title} · ${it.price}${matchTag(it) ? ` · ${matchTag(it)}` : ''}`,
      })),
    });
  }

  let total = 0;
  let counted = 0;
  const blocks = results.map(({ piece, items, near }) => {
    const vis = partial(piece) ? ` <i>(${esc(piece.visibility)})</i>` : '';
    const attrs = attrLine(piece.attributes);
    const head = `${piece.emoji || '•'} <b>${esc(piece.name_uk)}</b>${vis}${attrs ? `\n   🔬 <i>${esc(attrs)}</i>` : ''}`;
    const shown = items.length ? items : near;
    if (!shown.length) return `${head}\n   <i>точних збігів немає — дивись кнопку нижче</i>`;
    const prices = shown.map((x) => x.amount).filter((x) => x > 0);
    if (items.length && prices.length) {
      total += Math.min(...prices);
      counted++;
    }
    const lines = shown
      .map((x) => `   • <a href="${esc(x.url)}">${esc(x.title)}</a> — <b>${esc(x.price)}</b>${x.size ? ` · ${esc(x.size)}` : ''}${matchTag(x) ? ` · 🎯 ${matchTag(x)}` : ''}`)
      .join('\n');
    return `${head}\n${items.length ? '' : '   ≈ <i>найближчі за виглядом:</i>\n'}${lines}`;
  });

  const footer = [
    total > 0 ? `💰 Знайдені речі (${counted} з ${results.length}) — від <b>${total.toFixed(2).replace('.', ',')} €</b> разом` : '',
    blocked ? '⚠️ Частину речей Vinted не віддав напряму — відкрий пошук за кнопками.' : '',
  ].filter(Boolean);

  await sendLong(chatId, [`👗 <b>${esc(outfit.style_uk)}</b>`, ...blocks, ...footer], {
    inline_keyboard: outfit.pieces.map((p) => [{ text: `${p.emoji || '🔎'} ${p.name_uk}`.slice(0, 60), url: searchUrl(p.queries[0], outfit.price_max) }]),
  });
}

// ---------- Сховище для альбомів (Upstash Redis, опційно) ----------
const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const hasRedis = Boolean(REDIS_URL && REDIS_TOKEN);

async function redis(...cmd) {
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${REDIS_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const data = await r.json();
  if (data.error) throw new Error(`Redis: ${data.error}`);
  return data.result;
}

// Telegram надсилає альбом окремими повідомленнями з однаковим media_group_id.
// Кожне фото кладемо в Redis; обробляє альбом той виклик, після якого 2.5 с не приходило нових фото.
async function collectAlbum(msg, fileId) {
  const key = `mg:${msg.media_group_id}`;
  await redis('RPUSH', key, fileId);
  await redis('EXPIRE', key, 120);
  if (msg.caption) await redis('SET', `${key}:cap`, msg.caption, 'EX', 120);
  await redis('SET', `${key}:last`, String(Date.now()), 'EX', 120);

  await sleep(2500);
  const last = Number(await redis('GET', `${key}:last`));
  if (Date.now() - last < 2300) return null; // ще надходять фото — обробить пізніший виклик
  const lock = await redis('SET', `${key}:lock`, '1', 'NX', 'EX', 120);
  if (lock !== 'OK') return null; // вже обробляється
  const fileIds = await redis('LRANGE', key, 0, -1);
  const caption = (await redis('GET', `${key}:cap`)) || '';
  return { fileIds: [...new Set(fileIds)], caption };
}

// ---------- Обробка повідомлень ----------
const WELCOME = `👋 Привіт! Я шукаю речі на Vinted по фото.

📸 <b>Будь-яке фото</b> — обери, що шукати:
• 🔎 <b>схожу річ</b> — одну головну річ з фото
• 👗 <b>весь аутфіт</b> — знайду ВСЕ, що видно: одяг, взуття, сумки, аксесуари. Підходить селфі, фото по пояс, крупний план, речі на вішаку

🖼 <b>Кілька фото альбомом</b> — зберу з них один образ.

🔬 Кожен результат я перевіряю по фото й показую відсоток схожості 🎯

💡 Підпис до фото враховується: <i>розмір M</i>, <i>до 30€</i>, <i>тільки куртка</i>. Слово <i>аутфіт</i> у підписі — одразу шукаю весь образ.

✍️ Або просто напиши текстом, що шукаєш — можна українською, я сам перекладу 🇩🇪🇬🇧`;

const OUTFIT_WORDS = /аутфіт|аутфит|образ|\bлук\b|outfit|look/i;

function photoFrom(msg) {
  if (msg?.photo?.length) return { fileId: msg.photo[msg.photo.length - 1].file_id, mediaType: 'image/jpeg' };
  if (msg?.document?.mime_type?.startsWith('image/')) return { fileId: msg.document.file_id, mediaType: msg.document.mime_type };
  return null;
}

async function startItemFromPhoto(chatId, statusId, photo, caption) {
  let original;
  let piece;
  try {
    original = { base64: await downloadTelegramFile(photo.fileId), mediaType: photo.mediaType };
    piece = await analyzeItem([original], caption);
  } catch (e) {
    console.error('Analyze error:', e.message);
    return tg('editMessageText', {
      chat_id: chatId,
      message_id: statusId,
      text: '😕 Не вдалося розпізнати річ на фото. Спробуй інше фото або обери «Весь аутфіт».',
    });
  }
  await tg('editMessageText', { chat_id: chatId, message_id: statusId, text: `👀 Це ${piece.name_uk}.\n🔎 Шукаю на Vinted…` });
  return runItem(chatId, statusId, piece, original);
}

// Кнопки «річ / аутфіт» під фото
async function handleCallback(cq) {
  const chatId = cq.message?.chat?.id;
  const original = cq.message?.reply_to_message; // фото, на яке бот відповів кнопками
  const photo = photoFrom(original);
  await tg('answerCallbackQuery', { callback_query_id: cq.id });
  if (!chatId || !photo) {
    return tg('editMessageText', { chat_id: chatId, message_id: cq.message?.message_id, text: '😕 Не бачу фото. Надішли його ще раз.' });
  }
  const statusId = cq.message.message_id;
  const caption = original.caption || '';
  if (cq.data === 'outfit') {
    await tg('editMessageText', { chat_id: chatId, message_id: statusId, text: '👗 Розбираю все, що є на фото…' });
    return runOutfit(chatId, statusId, [photo.fileId], caption);
  }
  await tg('editMessageText', { chat_id: chatId, message_id: statusId, text: '🔍 Детально розглядаю річ…' });
  return startItemFromPhoto(chatId, statusId, photo, caption);
}

async function handleUpdate(update) {
  if (update.callback_query) return handleCallback(update.callback_query);

  const msg = update.message;
  if (!msg) return;
  const chatId = msg.chat.id;

  if (msg.text && /^\/(start|help)/.test(msg.text)) {
    return tg('sendMessage', { chat_id: chatId, text: WELCOME, parse_mode: 'HTML' });
  }

  if (msg.document?.mime_type?.startsWith('image/')) {
    const ok = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (!ok.includes(msg.document.mime_type)) {
      return tg('sendMessage', { chat_id: chatId, text: 'Надішли, будь ласка, JPG, PNG або WEBP 🙏' });
    }
  }

  const photo = photoFrom(msg);
  if (photo) {
    // Альбом із кількох фото → один аутфіт
    if (msg.media_group_id && hasRedis) {
      const album = await collectAlbum(msg, photo.fileId);
      if (!album) return;
      const status = await tg('sendMessage', { chat_id: chatId, text: `👗 Отримав ${album.fileIds.length} фото, розбираю образ…` });
      const note = album.fileIds.length > MAX_AI_PHOTOS ? `\n\nℹ️ Аналізую перші ${MAX_AI_PHOTOS} фото з ${album.fileIds.length}.` : '';
      return runOutfit(chatId, status.result?.message_id, album.fileIds, album.caption, note);
    }

    // Підпис зі словом «аутфіт» → одразу весь образ
    if (OUTFIT_WORDS.test(msg.caption || '')) {
      const status = await tg('sendMessage', { chat_id: chatId, text: '👗 Розбираю все, що є на фото…' });
      return runOutfit(chatId, status.result?.message_id, [photo.fileId], msg.caption || '');
    }

    // Інакше — питаємо, що шукати
    return tg('sendMessage', {
      chat_id: chatId,
      reply_to_message_id: msg.message_id,
      text: 'Що шукаємо?',
      reply_markup: {
        inline_keyboard: [[
          { text: '🔎 Схожу річ', callback_data: 'item' },
          { text: '👗 Весь аутфіт', callback_data: 'outfit' },
        ]],
      },
    });
  }

  // Текстовий пошук: AI перекладає запит на німецьку/англійську
  if (msg.text) {
    const q = msg.text.trim().slice(0, 200);
    const status = await tg('sendMessage', { chat_id: chatId, text: '🔍 Шукаю на Vinted…' });
    let piece;
    try {
      piece = await analyzeText(q);
    } catch (e) {
      console.error('Text analyze error:', e.message);
      const priceMatch = q.match(/(?:до|bis|under|max)\s*(\d+)\s*(€|eur|євро)?/i);
      const query = q.replace(/(?:до|bis|under|max)\s*\d+\s*(€|eur|євро)?/i, '').trim() || q;
      if (/[Ѐ-ӿ]/.test(query)) {
        return tg('editMessageText', {
          chat_id: chatId,
          message_id: status.result?.message_id,
          text: '😕 Не вдалося перекласти запит. Спробуй написати німецькою або англійською, напр. «Nike Air Force weiß».',
        });
      }
      piece = { name_uk: query, queries: [query], attributes: {}, price_max: priceMatch ? Number(priceMatch[1]) : null };
    }
    return runItem(chatId, status.result?.message_id, piece, null);
  }

  return tg('sendMessage', { chat_id: chatId, text: 'Надішли фото або напиши, що шукаєш 📸' });
}

// ---------- Vercel handler ----------
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('Vinted Photo Bot is running ✅');

  const secret = process.env.WEBHOOK_SECRET;
  if (secret && req.headers['x-telegram-bot-api-secret-token'] !== secret) {
    return res.status(401).send('unauthorized');
  }

  // Відповідаємо Telegram одразу, а детальний розбір продовжуємо у фоні —
  // так Telegram не надсилає те саме повідомлення повторно, поки бот думає
  const work = handleUpdate(req.body).catch((e) => console.error('Update error:', e));
  if (waitUntil) waitUntil(work);
  else await work;
  res.status(200).send('ok');
}
