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
const PROMPT = (caption) => `Ти допомагаєш знайти схожі речі на Vinted (${DOMAIN}).
Подивись на фото і визнач, що це за річ (одяг, взуття, аксесуар, техніка, декор тощо).
${caption ? `Побажання користувача (врахуй їх): "${caption}"` : ''}

Поверни ТІЛЬКИ JSON без пояснень:
{
  "item_uk": "короткий опис речі українською (до 10 слів)",
  "brand": "бренд, якщо видно логотип або впевнено впізнається, інакше null",
  "queries": ["найточніший запит", "ширший запит", "найширший запит"],
  "price_max": число в євро, якщо користувач вказав максимальну ціну, інакше null
}

Правила для queries:
- це пошукові запити для Vinted, мовою оголошень на цьому сайті (для vinted.de — німецька, бренди й моделі латиницею)
- 2–5 слів кожен: бренд + модель/тип + колір/ключова ознака, напр. "Nike Air Max 90 weiß", "Levi's 501 Jeans blau", "Strickpullover beige"
- від конкретного до загального; не вигадуй бренд, якщо не впевнений
- якщо користувач вказав розмір — додай його до першого запиту`;

async function analyzePhoto(base64, mediaType, caption) {
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
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: PROMPT(caption) },
            { type: 'image_url', image_url: { url: `data:${mediaType};base64,${base64}` } },
          ],
        },
      ],
    }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`Groq API: ${data?.error?.message || r.status}`);
  const text = (data.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '');
  const json = text.match(/\{[\s\S]*\}/);
  if (!json) throw new Error('AI не повернув результат');
  const parsed = JSON.parse(json[0]);
  parsed.queries = (parsed.queries || []).filter(Boolean).slice(0, 3);
  if (!parsed.queries.length) throw new Error('AI не зміг розпізнати річ');
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
    brand: it.brand_title || '',
    size: it.size_title || '',
    url: it.url || `https://${DOMAIN}/items/${it.id}`,
    photo: it.photo?.url || it.photo?.full_size_url || null,
  };
}

// Йдемо від точного запиту до ширшого, поки не наберемо достатньо результатів
async function findSimilar(queries, priceMax) {
  const seen = new Set();
  const results = [];
  for (const q of queries) {
    const items = await searchVinted(q, priceMax);
    for (const it of items) {
      if (seen.has(it.id)) continue;
      seen.add(it.id);
      results.push(it);
      if (results.length >= MAX_RESULTS) return results;
    }
  }
  return results;
}

// ---------- Відповіді користувачу ----------
const WELCOME = `👋 Привіт! Надішли мені <b>фото речі</b> — я знайду схожі оголошення на Vinted.

💡 Можна додати підпис до фото, напр.:
• <i>розмір M</i>
• <i>до 30€</i>
• <i>тільки чорні</i>

Або просто напиши текстом, що шукаєш.`;

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

async function handleUpdate(update) {
  const msg = update.message;
  if (!msg) return;
  const chatId = msg.chat.id;

  // /start, /help
  if (msg.text && /^\/(start|help)/.test(msg.text)) {
    return tg('sendMessage', { chat_id: chatId, text: WELCOME, parse_mode: 'HTML' });
  }

  // Фото (звичайне або надіслане як файл)
  let fileId = null;
  let mediaType = 'image/jpeg';
  if (msg.photo?.length) {
    fileId = msg.photo[msg.photo.length - 1].file_id; // найбільший розмір
  } else if (msg.document?.mime_type?.startsWith('image/')) {
    const ok = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (!ok.includes(msg.document.mime_type)) {
      return tg('sendMessage', { chat_id: chatId, text: 'Надішли, будь ласка, JPG, PNG або WEBP 🙏' });
    }
    fileId = msg.document.file_id;
    mediaType = msg.document.mime_type;
  }

  if (fileId) {
    const status = await tg('sendMessage', { chat_id: chatId, text: '🔍 Розглядаю фото…' });
    const statusId = status.result?.message_id;
    let analysis;
    try {
      const base64 = await downloadTelegramFile(fileId);
      analysis = await analyzePhoto(base64, mediaType, msg.caption || '');
    } catch (e) {
      console.error('Analyze error:', e.message);
      return tg('editMessageText', {
        chat_id: chatId,
        message_id: statusId,
        text: '😕 Не вдалося розпізнати річ на фото. Спробуй інше фото — краще одну річ крупним планом.',
      });
    }
    await tg('editMessageText', {
      chat_id: chatId,
      message_id: statusId,
      text: `👀 Це ${analysis.item_uk}. Шукаю на Vinted…`,
    });
    return runSearch(chatId, statusId, analysis);
  }

  // Текстовий пошук
  if (msg.text) {
    const q = msg.text.trim().slice(0, 100);
    const priceMatch = q.match(/до\s*(\d+)\s*(€|eur|євро)?/i);
    const query = q.replace(/до\s*\d+\s*(€|eur|євро)?/i, '').trim() || q;
    const status = await tg('sendMessage', { chat_id: chatId, text: '🔍 Шукаю на Vinted…' });
    return runSearch(chatId, status.result?.message_id, {
      item_uk: query,
      queries: [query],
      price_max: priceMatch ? Number(priceMatch[1]) : null,
    });
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
