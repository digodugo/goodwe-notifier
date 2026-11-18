# goodwe-notifier

Cloudflare Worker che controlla periodicamente l'impianto fotovoltaico (inverter GoodWe, portale **SEMS+**) e invia notifiche **Telegram** quando scattano certe soglie:

- batteria sotto il 10%
- batteria al 50% (attraversamento, in entrambe le direzioni)
- batteria al 100%
- produzione FV sopra 1 kW

Gira con un **Cron Trigger ogni 5 minuti** nel piano gratuito di Cloudflare Workers: niente VPS, niente Node.js in locale, si può pubblicare dalla dashboard Cloudflare.

## Come funziona

1. Il Cron Trigger lancia il Worker ogni 5 minuti.
2. Il Worker fa login a SEMS+ con l'autenticazione "web" (password in MD5+base64, header `Token` e `X-Signature` con firma SHA-256). La sessione è salvata in KV e riusata per ~30 minuti per evitare troppi login e rate limit.
3. Legge SOC batteria e potenza FV dall'endpoint `stations/flow`.
4. Valuta le regole in `RULES` (soglie con isteresi tramite `reset`, oppure `cross` per notificare solo quando un valore attraversa la soglia).
5. Invia il messaggio tramite Bot API di Telegram.

## File

- `src/index.js`: logica completa (login, lettura dati, regole, Telegram, endpoint di debug)
- `wrangler.toml`: nome Worker, cron, binding KV `STATE`
- `.gitignore`: esclude `.dev.vars` e file locali con segreti

## Setup

### 1. Bot Telegram

Crea un bot con [@BotFather](https://t.me/BotFather) e copia il token. Scrivi un messaggio al bot e ricava il tuo `chat_id` (ad esempio da `https://api.telegram.org/bot<TOKEN>/getUpdates`).

### 2. Secret

Dashboard Worker → Settings → Variables, oppure `wrangler secret put NOME`:

| Nome | Descrizione |
|---|---|
| `SEMS_ACCOUNT` | account/email del portale GoodWe SEMS+ |
| `SEMS_PASSWORD` | password dello stesso account |
| `STATION_ID` | id dell'impianto (vedi sotto) |
| `DEBUG_KEY` | chiave a piacere per proteggere l'endpoint di debug |
| `TELEGRAM_TOKEN` | token del bot Telegram |
| `TELEGRAM_CHAT_ID` | chat id destinatario |

**Non committare mai questi valori.**

### 3. KV namespace

```
wrangler kv:namespace create STATE
```

Copia l'`id` in `wrangler.toml` al posto di `<KV_NAMESPACE_ID>`.

### 4. Trovare lo STATION_ID

Dopo aver impostato `SEMS_ACCOUNT`, `SEMS_PASSWORD` e `DEBUG_KEY` e pubblicato il Worker, visita:

```
https://<il-tuo-worker>.workers.dev/?key=<DEBUG_KEY>&list=1
```

### 5. Deploy

Dalla dashboard Cloudflare (Workers & Pages) oppure con `wrangler deploy`.

## Endpoint di debug

Protetti da `?key=<DEBUG_KEY>`:

- `?key=XXX`: dati grezzi letti dall'impianto
- `&list=1`: elenco impianti (per trovare `STATION_ID`)
- `&diag=1`: verifica che i secret siano impostati (senza rivelarli)
- `&test=1`: invia subito una notifica Telegram di prova
- `&run=1`: esegue subito il controllo del cron (può inviare notifiche vere)

## Modificare le regole

In cima a `src/index.js`, nell'array `RULES`:

- `metric`: `"soc"` (batteria %) o `"pv"` (produzione FV in kW)
- `op`: `"<"`, `">"`, `">="` oppure `"cross"`
- `value`: soglia
- `reset`: valore oltre il quale la regola si riarma (non serve per `cross`)

## Nota

L'API SEMS+ non è documentata ufficialmente: se GoodWe cambia portale, endpoint o formato della firma, il codice potrebbe richiedere aggiornamenti.
