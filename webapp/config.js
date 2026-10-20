// Адрес API. Мини апп раздаётся тем же Cloudflare Worker, что и API, поэтому это текущий адрес.
// Если мини апп лежит на другом хостинге, укажите адрес воркера, например "https://caravel-mini-app.<аккаунт>.workers.dev".
window.CARAVEL_API = location.origin;
