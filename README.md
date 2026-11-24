# goodwe-notifier

Cloudflare Worker che controlla periodicamente l'impianto fotovoltaico (inverter GoodWe, portale **SEMS+**) e invia notifiche **Telegram** quando scattano certe soglie:

- batteria sotto il 10%
- batteria al 50% (attraversamento, in entrambe le direzioni)
- batteria al 100%
- produzione FV sopra 1 kW

Inoltre:

- **pagina web `/impostazioni`** per attivare/disattivare ogni notifica e cambiarne soglia, riarmo e titolo
- **registro delle rilevazioni**: ogni lettura (data e ora) viene salvata e si scarica come foglio Excel o CSV
- **eventi giornalieri**: per ogni giorno l'ora del primo raggiungimento del 50% di batteria, di 1 kW di potenza e di 1 kWh prodotto (solo il primo evento del giorno, mai sovrascritto)
- **riepilogo serale alle 21** su Telegram: produzione del giorno e batteria all'ultima rilevazione

> Backup della versione precedente (solo notifiche): branch `backup/v1-stabile`.

Gira con un **Cron Trigger ogni 5 minuti** nel piano gratuito di Cloudflare Workers: niente VPS, niente Node.js in locale, si può pubblicare dalla dashboard Cloudflare.

## Come funziona

1. Il Cron Trigger lancia il Worker ogni 5 minuti.
2. Il Worker fa login a SEMS+ con l'autenticazione "web" (password in MD5+base64, header `Token` e `X-Signature` con firma SHA-256). La sessione è salvata in KV e riusata per ~30 minuti per evitare troppi login e rate limit.
3. Legge SOC batteria e potenza FV dall'endpoint `stations/flow`.
4. Valuta le regole in `RULES` (soglie con isteresi tramite `reset`, oppure `cross` per notificare solo quando un valore attraversa la soglia).
5. Invia il messaggio tramite Bot API di Telegram.

## File

- `src/index.js`: logica completa (login, lettura dati, regole, Telegram, registro dati, export Excel, pagina impostazioni, endpoint di debug)
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
- `&run=1`: esegue subito il controllo del cron (può inviare notifiche vere e registra una rilevazione)
- `&summary=1`: invia subito il riepilogo giornaliero

## Pagina impostazioni

```
https://<il-tuo-worker>.workers.dev/impostazioni?key=<DEBUG_KEY>
```

Per ogni notifica: casella per attivarla o escluderla, titolo del messaggio, soglia e riarmo (il valore da superare nell'altro verso perché la notifica possa ripartire). Per il riepilogo giornaliero: casella di attivazione e ora di invio (predefinita 21). Premi **Salva**: le impostazioni sono salvate in KV (chiave `config`) e usate dal controllo successivo.

Conviene salvare il link tra i preferiti del telefono. Il link contiene la chiave: non condividerlo.

## Foglio elettronico

- `/export.xlsx?key=<DEBUG_KEY>`: file Excel con due fogli
  - **Rilevazioni**: una riga per lettura (Data, Ora, Batteria %, Potenza FV kW, Produzione giorno kWh dal portale, Produzione giorno kWh stimata)
  - **Eventi giornalieri**: una riga per giorno (ora batteria 50%, ora prima potenza 1 kW, ora primo 1 kWh prodotto, produzione del giorno)
- `/rilevazioni.csv?key=...` e `/eventi.csv?key=...`: gli stessi dati in CSV (separatore `;`)
- opzionale `&from=AAAA-MM-GG&to=AAAA-MM-GG` per limitare il periodo

I dati restano in KV: il giorno corrente nella chiave `state`, i giorni passati in `log:AAAA-MM-GG`. Lo stato è scritto una sola volta per esecuzione per restare nel limite gratuito di 1000 scritture KV al giorno.

**Produzione giornaliera**: se il portale SEMS+ restituisce la produzione di oggi (campi tipo `eDay`, `todayPv`, ...) viene usata quella; altrimenti è stimata integrando la potenza letta ogni 5 minuti (nel riepilogo compare "stimata"). Se nei dati grezzi (`?key=XXX`) vedi il campo giusto con un altro nome, impostalo nella variabile del Worker `ENERGY_FIELD`.

**Batteria 50%** viene registrata quando la batteria sale da sotto a sopra il 50%.

## Modificare le regole predefinite

I valori di partenza sono in cima a `src/index.js`, nell'array `DEFAULT_RULES` (le modifiche fatte dalla pagina impostazioni hanno la precedenza):

- `metric`: `"soc"` (batteria %) o `"pv"` (produzione FV in kW)
- `op`: `"<"`, `">"`, `">="` oppure `"cross"`
- `value`: soglia
- `reset`: valore oltre il quale la regola si riarma (non serve per `cross`)

## Nota

L'API SEMS+ non è documentata ufficialmente: se GoodWe cambia portale, endpoint o formato della firma, il codice potrebbe richiedere aggiornamenti.
