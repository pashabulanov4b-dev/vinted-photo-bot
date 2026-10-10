// Vinted Photo Search Bot — Telegram webhook (Vercel serverless function)
// Фото → безкоштовний AI (Groq) розпізнає річ → пошук на Vinted → схожі оголошення

// Прибираємо пробіли, лапки й випадковий префікс "bot", щоб токен з Vercel завжди був чистим
const BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim().replace(/^['"]|['"]$/g, '').replace(/^bot/i, '');
if (!BOT_TOKEN) console.error('TELEGRAM_BOT_TOKEN не задано у Vercel → Settings → Environment Variables');
const TG = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TG_FILE = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
const DOMAIN = process.env.VINTED_DOMAIN || 'www.vinted.de';
const MODEL = process.env.GROQ_MODEL || 'qwen/qwen3.8-27b';
const MAX_RESULTS = 6;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';

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

const esc = (s = '') =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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

// ---------- AI (розпізнавання фото, Groq) ----------
const LANG_RULES = `Правила для queries:
- ТІЛЬКИ німецькою або англійською мовою. Жодних українських, російських чи інших слів, жодної кирилиці
- перші два запити — німецькою (так пишуть більшість оголошень на Vinted у Німеччині), третій — англійською
- бренди й назви моделей завжди латиницею в оригінальному написанні (Nike, Air Force 1, Levi's 501)
- 2–5 слів кожен: бренд + модель/тип + колір/ключова ознака, напр. "Nike Air Max 90 weiß", "Levi's 501 Jeans blau", "Strickpullover beige", "black leather jacket"
- від конкретного до загального; не вигадуй бренд, якщо не впевнений
- якщо користувач вказав розмір — додай його до першого запиту
- ціну НЕ додавай у запити, а винеси в price_max`;

const JSON_SHAPE = `Поверни ТІЛЬКИ JSON без пояснень:
{
  "item_uk": "короткий опис речі українською (до 10 слів)",
  "brand": "бренд, якщо відомий, інакше null",
  "queries": ["найточніший запит", "ширший запит", "найширший запит"],
  "price_max": число в євро, якщо користувач вказав максимальну ціну, інакше null
}`;

const PHOTO_PROMPT = (caption) => `Ти допомагаєш знайти схожі речі на Vinted.
Подивись на фото і визнач, що це за річ (одяг, взуття, аксесуар, техніка, декор тощо).
${caption ? `Побажання користувача (врахуй їх): "${caption}"` : ''}

${JSON_SHAPE}

${LANG_RULES}`;

const TEXT_PROMPT = (text) => `Ти допомагаєш знайти речі на Vinted. Користувач написав, що шукає (може бути будь-якою мовою):
"${text}"

Переклади й перетвори це на пошукові запити.

${JSON_SHAPE}

${LANG_RULES}`;

async function askJSON(content) {
  // Groq — безкоштовний OpenAI-сумісний API з підтримкою фото
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2000,
      temperature: 0.2,
      messages: [{ role: 'user', content }],
    }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`Groq API: ${data?.error?.message || r.status}`);
  const text = (data.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '');
  const json = text.match(/\{[\s\S]*\}/);
  if (!json) throw new Error('AI не повернув результат');
  return JSON.parse(json[0]);
}

// Страховка: відкидаємо запити з кирилицею, лишаємо тільки DE/EN
const cleanQueries = (qs, max = 3) =>
  (qs || [])
    .map((q) => String(q || '').trim())
    .filter((q) => q && !/[\u0400-\u04FF]/.test(q))
    .slice(0, max);

async function askAI(content) {
  const parsed = await askJSON(content);
  parsed.queries = cleanQueries(parsed.queries);
  if (!parsed.queries.length) throw new Error('AI не зміг розпізнати річ');
  return parsed;
}

const analyzePhoto = (base64, mediaType, caption) =>
  askAI([
    { type: 'text', text: PHOTO_PROMPT(caption) },
    { type: 'image_url', image_url: { url: `data:${mediaType};base64,${base64}` } },
  ]);

const analyzeText = (text) => askAI(TEXT_PROMPT(text));

const OUTFIT_PROMPT = (caption, count) => `Ти стиліст і допомагаєш зібрати аутфіт на Vinted.
${count > 1 ? `Ось ${count} фото — це частини ОДНОГО образу (різні ракурси або окремі речі). Не дублюй ту саму річ, якщо вона є на кількох фото.` : 'На фото — образ (аутфіт).'}
Визнач кожну окрему річ образу: верхній одяг, верх, низ, сукня, взуття, сумка, головний убір, помітні аксесуари. Максимум 6 речей, від найпомітнішої.
${caption ? `Побажання користувача (врахуй їх): "${caption}"` : ''}

Поверни ТІЛЬКИ JSON без пояснень:
{
  "style_uk": "стиль образу українською (до 8 слів)",
  "price_max": число в євро, якщо користувач вказав бюджет на ОДНУ річ, інакше null,
  "items": [
    { "emoji": "один емодзі для речі", "name_uk": "назва речі українською (до 6 слів)", "queries": ["точний запит", "ширший запит"] }
  ]
}

Правила для queries:
- ТІЛЬКИ німецькою або англійською, жодної кирилиці
- перший запит — німецькою, другий — німецькою або англійською
- бренди латиницею, лише якщо видно логотип; не вигадуй бренд
- 2–5 слів: (бренд) + тип речі + колір/матеріал/фасон, напр. "Lederjacke schwarz oversize", "Mom Jeans hellblau", "chunky sneaker white"`;

async function analyzeOutfit(images, caption) {
  const parsed = await askJSON([
    { type: 'text', text: OUTFIT_PROMPT(caption, images.length) },
    ...images.map((img) => ({ type: 'image_url', image_url: { url: `data:${img.mediaType};base64,${img.base64}` } })),
  ]);
  parsed.items = (parsed.items || [])
    .map((it) => ({ ...it, queries: cleanQueries(it.queries, 2) }))
    .filter((it) => it.queries.length)
    .slice(0, 6);
  if (!parsed.items.length) throw new Error('AI не знайшов речей на фото');
  return parsed;
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
  const url = new URL(`https://${DOMAIN}/api/v2/catalog/items`);
  url.searchParams.set('search_text', query);
  url.searchParams.set('per_page', '20');
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
  if ((r.status === 401 || r.status === 403) && retry) return searchVinted(query, priceMax, false);
  if (!r.ok) throw new Error(`Vinted відповів ${r.status}`);
  const data = await r.json();
  return (data.items || []).map(normalizeItem);
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

// Йдемо від точного запиту до ширшого, поки не наберемо достатньо результатів
async function findSimilar(queries, priceMax, limit = MAX_RESULTS) {
  const seen = new Set();
  const results = [];
  for (const q of queries) {
    const items = await searchVinted(q, priceMax);
    for (const it of items) {
      if (seen.has(it.id)) continue;
      seen.add(it.id);
      results.push(it);
      if (results.length >= limit) return results;
    }
  }
  return results;
}

// ---------- Відповіді користувачу ----------
const WELCOME = `👋 Привіт! Я шукаю речі на Vinted по фото.

📸 <b>Одне фото</b> — обери, що шукати:
• 🔎 <b>схожу річ</b>
• 👗 <b>весь аутфіт</b> — знайду кожну річ з образу окремо

🖼 <b>Кілька фото альбомом</b> — зберу з них один аутфіт.

💡 Підпис до фото враховується: <i>розмір M</i>, <i>до 30€</i>, <i>тільки чорні</i>. Слово <i>аутфіт</i> у підписі — одразу шукаю весь образ.

✍️ Або просто напиши текстом, що шукаєш — можна українською, я сам перекладу 🇩🇪🇬🇧`;

function queryButtons(queries, priceMax) {
  return queries.map((q) => [{ text: `🔎 ${q}`, url: searchUrl(q, priceMax) }]);
}

async function sendResults(chatId, analysis, items) {
  const { item_uk, queries, price_max } = analysis;

  const withPhoto = items.filter((i) => i.photo);
  if (withPhoto.length >= 2) {
    await tg('sendMediaGroup', {
      chat_id: chatId,
      media: withPhoto.map((it, i) => ({
        type: 'photo',
        media: it.photo,
        caption: `${items.indexOf(it) + 1}. ${it.title}\n${[it.price, it.brand, it.size].filter(Boolean).join(' · ')}`,
      })),
    });
  }

  const list = items
    .map(
      (it, i) =>
        `${i + 1}. <a href="${esc(it.url)}">${esc(it.title)}</a>\n   💶 <b>${esc(it.price)}</b>${it.brand ? ` · ${esc(it.brand)}` : ''}${it.size ? ` · ${esc(it.size)}` : ''}`,
    )
    .join('\n\n');

  await tg('sendMessage', {
    chat_id: chatId,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    text: `🧥 <b>${esc(item_uk)}</b>${price_max ? ` · до ${price_max}€` : ''}\n\n${list}\n\nБільше результатів — за кнопками 👇`,
    reply_markup: { inline_keyboard: queryButtons(queries, price_max) },
  });
}

async function sendFallback(chatId, analysis, reason) {
  const { item_uk, queries, price_max } = analysis;
  await tg('sendMessage', {
    chat_id: chatId,
    parse_mode: 'HTML',
    text: `🧥 Розпізнав: <b>${esc(item_uk)}</b>\n\n${
      reason === 'empty'
        ? 'На жаль, точних збігів не знайшлося.'
        : 'Vinted зараз не віддав результати напряму.'
    } Відкрий пошук за кнопками 👇`,
    reply_markup: { inline_keyboard: queryButtons(queries, price_max) },
  });
}

async function runSearch(chatId, statusId, analysis) {
  try {
    const items = await findSimilar(analysis.queries, analysis.price_max);
    if (statusId) await tg('deleteMessage', { chat_id: chatId, message_id: statusId });
    if (!items.length) return sendFallback(chatId, analysis, 'empty');
    await sendResults(chatId, analysis, items);
  } catch (e) {
    console.error('Vinted search error:', e.message);
    if (statusId) await tg('deleteMessage', { chat_id: chatId, message_id: statusId });
    await sendFallback(chatId, analysis, 'blocked');
  }
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// ---------- Аутфіт ----------
const MAX_OUTFIT_PHOTOS = 3; // ліміт моделі Groq на кількість фото в одному запиті

async function runOutfit(chatId, statusId, fileIds, caption, extraNote = '') {
  const setStatus = (text) => tg('editMessageText', { chat_id: chatId, message_id: statusId, text });
  let outfit;
  try {
    const images = [];
    for (const id of fileIds.slice(0, MAX_OUTFIT_PHOTOS)) {
      images.push({ base64: await downloadTelegramFile(id), mediaType: 'image/jpeg' });
    }
    outfit = await analyzeOutfit(images, caption);
  } catch (e) {
    console.error('Outfit analyze error:', e.message);
    return setStatus('😕 Не вдалося розібрати образ. Спробуй фото, де людину видно на повний зріст і речі добре помітно.');
  }

  const list = outfit.items.map((it) => `${it.emoji || '•'} ${it.name_uk}`).join('\n');
  await setStatus(`👗 ${outfit.style_uk}\n\nШукаю на Vinted:\n${list}${extraNote}`);

  // Шукаємо кожну річ (по 2 паралельно, щоб не злити Vinted)
  const results = [];
  let blocked = false;
  for (let i = 0; i < outfit.items.length; i += 2) {
    const batch = outfit.items.slice(i, i + 2);
    const found = await Promise.all(
      batch.map((it) =>
        findSimilar(it.queries, outfit.price_max, 3).catch((e) => {
          console.error('Outfit search error:', e.message);
          blocked = true;
          return [];
        }),
      ),
    );
    batch.forEach((it, j) => results.push({ piece: it, items: found[j] }));
  }

  await tg('deleteMessage', { chat_id: chatId, message_id: statusId });

  // Альбом: найкращий збіг для кожної речі
  const best = results.filter((r) => r.items[0]?.photo);
  if (best.length >= 2) {
    await tg('sendMediaGroup', {
      chat_id: chatId,
      media: best.map((r) => ({
        type: 'photo',
        media: r.items[0].photo,
        caption: `${r.piece.emoji || ''} ${r.piece.name_uk}\n${r.items[0].title} · ${r.items[0].price}`,
      })),
    });
  }

  let total = 0;
  const blocks = results.map(({ piece, items }) => {
    const head = `${piece.emoji || '•'} <b>${esc(piece.name_uk)}</b>`;
    if (!items.length) return `${head}\n   <i>не знайшлося — дивись кнопку нижче</i>`;
    const cheapest = Math.min(...items.map((x) => x.amount).filter((x) => x > 0));
    if (Number.isFinite(cheapest)) total += cheapest;
    const lines = items
      .map((x) => `   • <a href="${esc(x.url)}">${esc(x.title)}</a> — <b>${esc(x.price)}</b>${x.size ? ` · ${esc(x.size)}` : ''}`)
      .join('\n');
    return `${head}\n${lines}`;
  });

  const totalLine = total > 0 ? `\n\n💰 Весь образ — від <b>${total.toFixed(2).replace('.', ',')} €</b> (найдешевші варіанти)` : '';
  const blockedLine = blocked ? '\n\n⚠️ Частину речей Vinted не віддав напряму — відкрий пошук за кнопками.' : '';

  await tg('sendMessage', {
    chat_id: chatId,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    text: `👗 <b>${esc(outfit.style_uk)}</b>\n\n${blocks.join('\n\n')}${totalLine}${blockedLine}`,
    reply_markup: {
      inline_keyboard: outfit.items.map((it) => [
        { text: `${it.emoji || '🔎'} ${it.name_uk}`, url: searchUrl(it.queries[0], outfit.price_max) },
      ]),
    },
  });
}

// ---------- Одна річ ----------
async function runItem(chatId, statusId, fileId, mediaType, caption) {
  let analysis;
  try {
    const base64 = await downloadTelegramFile(fileId);
    analysis = await analyzePhoto(base64, mediaType, caption);
  } catch (e) {
    console.error('Analyze error:', e.message);
    return tg('editMessageText', {
      chat_id: chatId,
      message_id: statusId,
      text: '😕 Не вдалося розпізнати річ на фото. Спробуй інше фото — краще одну річ крупним планом.',
    });
  }
  await tg('editMessageText', { chat_id: chatId, message_id: statusId, text: `👀 Це ${analysis.item_uk}. Шукаю на Vinted…` });
  return runSearch(chatId, statusId, analysis);
}

const OUTFIT_WORDS = /аутфіт|аутфит|образ|\bлук\b|outfit|look/i;

function photoFrom(msg) {
  if (msg?.photo?.length) return { fileId: msg.photo[msg.photo.length - 1].file_id, mediaType: 'image/jpeg' };
  if (msg?.document?.mime_type?.startsWith('image/')) return { fileId: msg.document.file_id, mediaType: msg.document.mime_type };
  return null;
}

// Кнопки «річ / аутфіт» під фото
async function handleCallback(cq) {
  const chatId = cq.message?.chat?.id;
  const original = cq.message?.reply_to_message; // фото, на яке бот відповів кнопками
  const photo = photoFrom(original);
  await tg('answerCallbackQuery', { callback_query_id: cq.id });
  if (!chatId || !photo) {
    return tg('editMessageText', {
      chat_id: chatId,
      message_id: cq.message?.message_id,
      text: '😕 Не бачу фото. Надішли його ще раз.',
    });
  }
  const statusId = cq.message.message_id;
  const caption = original.caption || '';
  if (cq.data === 'outfit') {
    await tg('editMessageText', { chat_id: chatId, message_id: statusId, text: '👗 Розбираю образ…' });
    return runOutfit(chatId, statusId, [photo.fileId], caption);
  }
  await tg('editMessageText', { chat_id: chatId, message_id: statusId, text: '🔍 Розглядаю фото…' });
  return runItem(chatId, statusId, photo.fileId, photo.mediaType, caption);
}

async function handleUpdate(update) {
  if (update.callback_query) return handleCallback(update.callback_query);

  const msg = update.message;
  if (!msg) return;
  const chatId = msg.chat.id;

  // /start, /help
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
      const status = await tg('sendMessage', {
        chat_id: chatId,
        text: `👗 Отримав ${album.fileIds.length} фото, розбираю образ…`,
      });
      const note =
        album.fileIds.length > MAX_OUTFIT_PHOTOS
          ? `\n\nℹ️ Аналізую перші ${MAX_OUTFIT_PHOTOS} фото з ${album.fileIds.length}.`
          : '';
      return runOutfit(chatId, status.result?.message_id, album.fileIds, album.caption, note);
    }

    // Підпис зі словом «аутфіт» → одразу весь образ
    if (OUTFIT_WORDS.test(msg.caption || '')) {
      const status = await tg('sendMessage', { chat_id: chatId, text: '👗 Розбираю образ…' });
      return runOutfit(chatId, status.result?.message_id, [photo.fileId], msg.caption || '');
    }

    // Інакше — питаємо, що шукати
    return tg('sendMessage', {
      chat_id: chatId,
      reply_to_message_id: msg.message_id,
      text: 'Що шукаємо?',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '🔎 Схожу річ', callback_data: 'item' },
            { text: '👗 Весь аутфіт', callback_data: 'outfit' },
          ],
        ],
      },
    });
  }

  // Текстовий пошук: AI перекладає запит на німецьку/англійську
  if (msg.text) {
    const q = msg.text.trim().slice(0, 150);
    const status = await tg('sendMessage', { chat_id: chatId, text: '🔍 Шукаю на Vinted…' });
    let analysis;
    try {
      analysis = await analyzeText(q);
    } catch (e) {
      console.error('Text analyze error:', e.message);
      // Запасний варіант: шукаємо як є, якщо запит уже латиницею
      const priceMatch = q.match(/(?:до|bis|under|max)\s*(\d+)\s*(€|eur|євро)?/i);
      const query = q.replace(/(?:до|bis|under|max)\s*\d+\s*(€|eur|євро)?/i, '').trim() || q;
      if (/[\u0400-\u04FF]/.test(query)) {
        return tg('editMessageText', {
          chat_id: chatId,
          message_id: status.result?.message_id,
          text: '😕 Не вдалося перекласти запит. Спробуй написати німецькою або англійською, напр. «Nike Air Force weiß».',
        });
      }
      analysis = { item_uk: query, queries: [query], price_max: priceMatch ? Number(priceMatch[1]) : null };
    }
    return runSearch(chatId, status.result?.message_id, analysis);
  }


  return tg('sendMessage', { chat_id: chatId, text: 'Надішли фото речі або напиши, що шукаєш 📸' });
}

// ---------- Vercel handler ----------
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('Vinted Photo Bot is running ✅');

  const secret = process.env.WEBHOOK_SECRET;
  if (secret && req.headers['x-telegram-bot-api-secret-token'] !== secret) {
    return res.status(401).send('unauthorized');
  }

  try {
    await handleUpdate(req.body);
  } catch (e) {
    console.error('Update error:', e);
  }
  res.status(200).send('ok');
}
