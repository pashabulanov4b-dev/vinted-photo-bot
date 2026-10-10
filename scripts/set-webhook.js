// Запуск: TELEGRAM_BOT_TOKEN=... WEBHOOK_SECRET=... node scripts/set-webhook.js https://твій-проєкт.vercel.app
const [, , baseUrl] = process.argv;
const { TELEGRAM_BOT_TOKEN: token, WEBHOOK_SECRET: secret } = process.env;
if (!token || !baseUrl) {
  console.error('Використання: TELEGRAM_BOT_TOKEN=... WEBHOOK_SECRET=... node scripts/set-webhook.js https://xxx.vercel.app');
  process.exit(1);
}
const api = (m, body) =>
  fetch(`https://api.telegram.org/bot${token}/${m}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json());

console.log(await api('setWebhook', {
  url: `${baseUrl.replace(/\/$/, '')}/api/webhook`,
  secret_token: secret || undefined,
  allowed_updates: ['message', 'callback_query'],
  drop_pending_updates: true,
}));
console.log(await api('setMyCommands', { commands: [{ command: 'start', description: 'Як користуватись ботом' }] }));
console.log(await api('setMyDescription', { description: 'Надішли фото речі — знайду схожі оголошення на Vinted 🛍️' }));
