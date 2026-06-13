# Nostra.chat vs Telegram — Feature Matrix

## Legenda

| Simbolo | Significato |
|---------|-------------|
| P2P OK | Funziona in modalita' P2P Nostr, verificato E2E |
| P2P Parziale | Codice esiste, parzialmente funzionante in P2P |
| tweb Only | Codice ereditato da tweb, richiede MTProto (non funziona P2P) |
| Missing | Non implementato |
| N/A | Non applicabile al modello P2P/Nostr |
| Nostra+ | Feature unica di Nostra.chat, non presente in Telegram |

## Priorita'

| Livello | Criterio |
|---------|----------|
| P0 | Core — senza questa feature il prodotto non e' usabile |
| P1 | Essenziale — utenti se lo aspettano da un messenger |
| P2 | Importante — migliora significativamente l'esperienza |
| P3 | Nice-to-have — differenziante ma non critico |
| P4 | Futuro — bassa urgenza o alta complessita' |

---

## 1. Onboarding & Account

| # | Feature Telegram | Stato Nostra.chat | Priorita' | Note |
|---|-----------------|-------------------|-----------|------|
| 1.1 | Registrazione con numero di telefono | N/A | - | Nostra usa keypair, nessun telefono richiesto |
| 1.2 | Login via SMS/Call | N/A | - | Nostra usa seed phrase / keypair |
| 1.3 | QR code login (multi-device) | tweb Only | P3 | QRIdentity esiste ma per sharing npub, non multi-device login |
| 1.4 | - | Nostra+: Creazione identita' con seed phrase BIP39 | P0 | Implementato e funzionante |
| 1.5 | - | Nostra+: Import seed phrase | P0 | Implementato |
| 1.6 | - | Nostra+: Display name setup durante onboarding | P0 | Implementato |
| 1.7 | - | Nostra+: Dicebear avatar auto-generato | P0 | Implementato, verificato E2E |
| 1.8 | 2FA (password) | P2P OK: PIN/Passphrase con PBKDF2 | P1 | Key protection: none/PIN/passphrase |
| 1.9 | - | Nostra+: NIP-05 identity verification | P2 | Implementato |
| 1.10 | - | Nostra+: No phone number required | P0 | Core value proposition |

## 2. Contacts & Discovery

| # | Feature Telegram | Stato Nostra.chat | Priorita' | Note |
|---|-----------------|-------------------|-----------|------|
| 2.1 | Aggiungere contatto (telefono) | P2P OK: aggiungere via npub | P0 | Verificato E2E (1.1) |
| 2.2 | Nickname contatto | P2P OK | P0 | Verificato E2E (1.1) |
| 2.3 | Contatto senza nickname → mostra nome | P2P OK: mostra npub troncato | P0 | Verificato E2E (1.2) |
| 2.4 | Persistenza contatti | P2P OK | P0 | Verificato E2E (1.3) |
| 2.5 | Profile fetch da server | P2P Parziale: kind 0 fetch da relay | P1 | CHECKLIST 1.4 non verificato |
| 2.6 | Foto profilo contatto | P2P OK: Dicebear SVG | P1 | Verificato E2E (1.5, 1.6, 1.7) |
| 2.7 | Cerca contatti per nome/username | tweb Only | P2 | Search contatti non adattato a P2P |
| 2.8 | Sync contatti dalla rubrica | N/A | - | Nostra non usa numeri di telefono |
| 2.9 | Blocca contatto | P2P Parziale | P1 | UI esiste, blocco P2P da verificare |
| 2.10 | - | Nostra+: QR code per condivisione npub | P2 | QRIdentity/QRScanner implementati |
| 2.11 | Username pubblico (@user) | P2P Parziale: NIP-05 | P2 | NIP-05 e' l'equivalente Nostr |
| 2.12 | Last seen / online status | P2P Parziale: kind 30315 heartbeat | P2 | CHECKLIST 1.8 non verificato |

## 3. Messaggistica 1:1

| # | Feature Telegram | Stato Nostra.chat | Priorita' | Note |
|---|-----------------|-------------------|-----------|------|
| 3.1 | Inviare messaggio testo | P2P OK | P0 | Verificato E2E (2.1) |
| 3.2 | Bolla messaggio (destra = inviato) | P2P OK | P0 | Verificato E2E (2.1) |
| 3.3 | Bolla messaggio (sinistra = ricevuto) | P2P OK | P0 | Verificato E2E (3.4) |
| 3.4 | Spunta invio (sent) | P2P OK | P0 | Verificato E2E (2.2, 6.2) |
| 3.5 | Doppia spunta (delivered) | P2P Parziale | P1 | Delivery tracker esiste, non verificato E2E |
| 3.6 | Doppia spunta blu (read) | P2P Parziale | P1 | Read receipt toggle funziona (9.1), delivery stato da verificare |
| 3.7 | Messaggio in chat list preview | P2P OK | P0 | Verificato E2E (2.4, 4.9) |
| 3.8 | Ricezione real-time | P2P OK | P0 | Verificato E2E (3.1) |
| 3.9 | Ricezione dopo reload | P2P OK | P0 | Verificato E2E (3.2) |
| 3.10 | Emoji nell'input | P2P OK | P1 | Verificato E2E (2.5) |
| 3.11 | Emoji autocomplete (:smile) | P2P OK | P2 | Verificato E2E (2.6) |
| 3.12 | Typing indicator | tweb Only | P2 | Non implementato via Nostr |
| 3.13 | Timestamp corretto sui messaggi | P2P OK | P0 | Verificato E2E (4.4) |
| 3.14 | Ordine cronologico messaggi | P2P OK | P0 | Verificato E2E (4.1-4.3) |
| 3.15 | Nessun duplicato dopo reload | P2P OK | P0 | Verificato E2E (4.7) |
| 3.16 | Persistenza dopo reload (sender) | P2P Parziale | P0 | CHECKLIST 4.5 non verificato |
| 3.17 | Persistenza dopo reload (receiver) | P2P Parziale | P0 | CHECKLIST 4.6 non verificato |
| 3.18 | Separatore "Today" | P2P OK | P2 | Verificato E2E (4.10) |

## 4. Modifica & Cancellazione Messaggi

| # | Feature Telegram | Stato Nostra.chat | Priorita' | Note |
|---|-----------------|-------------------|-----------|------|
| 4.1 | Edit messaggio inviato | tweb Only | P1 | Codice esiste, non adattato a P2P (NIP supporta) |
| 4.2 | Right-click → context menu | P2P OK | P0 | Verificato E2E (6.4) |
| 4.3 | Long-press → context menu (mobile) | P2P OK | P1 | Verificato E2E (6.5) |
| 4.4 | "Elimina per me" | P2P OK | P0 | Verificato E2E (6.7) |
| 4.5 | "Elimina per tutti" | P2P Parziale | P1 | CHECKLIST 6.8 non verificato, richiede NIP-09 kind 5 |
| 4.6 | Cancellazione dal peer ricevuta | Missing | P1 | CHECKLIST 6.9 non verificato |
| 4.7 | Cancellazione persiste dopo reload | P2P OK | P0 | Verificato E2E (6.10) |
| 4.8 | Elimina chat "solo per me" | P2P OK | P0 | Verificato E2E (6.12) |
| 4.9 | Elimina chat "anche per l'altro" | Missing | P1 | CHECKLIST 6.13, richiede NIP-09 |
| 4.10 | Chat eliminata non riappare dopo reload | P2P OK | P0 | Verificato E2E (6.14) |
| 4.11 | Nuovo msg dal peer → nuova chat appare | Missing | P1 | CHECKLIST 6.15 non verificato |
| 4.12 | Auto-delete messages (TTL) | tweb Only | P3 | UI esiste, non adattato a P2P |

## 5. Search

| # | Feature Telegram | Stato Nostra.chat | Priorita' | Note |
|---|-----------------|-------------------|-----------|------|
| 5.1 | Search globale messaggi | tweb Only | P2 | Richiede indicizzazione P2P messages |
| 5.2 | Search nella conversazione | Missing | P1 | CHECKLIST 2B.1-2B.3 tutti non verificati |
| 5.3 | Click risultato → scroll al messaggio | Missing | P2 | CHECKLIST 2B.3 |
| 5.4 | Filtro per tipo (foto, link, file) | tweb Only | P3 | Non adattato a P2P |

## 6. Reply & Forward

| # | Feature Telegram | Stato Nostra.chat | Priorita' | Note |
|---|-----------------|-------------------|-----------|------|
| 6.1 | Reply a messaggio (quote) | tweb Only | P1 | Codice esiste, non adattato a P2P |
| 6.2 | Forward messaggio | tweb Only | P2 | Codice esiste, non adattato a P2P |
| 6.3 | Reply visibile come bolla quotata | tweb Only | P1 | UI esiste |

## 7. Media & File

| # | Feature Telegram | Stato Nostra.chat | Priorita' | Note |
|---|-----------------|-------------------|-----------|------|
| 7.1 | Inviare foto | P2P Parziale | P0 | Blossom encrypt+upload, CHECKLIST 8.1 non verificato |
| 7.2 | Ricevere foto inline | Missing | P0 | CHECKLIST 8.1 |
| 7.3 | Inviare video | P2P Parziale | P1 | CHECKLIST 8.2 non verificato |
| 7.4 | Ricevere video con play | Missing | P1 | CHECKLIST 8.2 |
| 7.5 | Media size limits | P2P OK (codice) | P1 | 10MB foto, 50MB video — da verificare |
| 7.6 | Voice note (registra e invia) | tweb Only | P2 | UI esiste, non adattato a P2P |
| 7.7 | Inviare documenti/file | tweb Only | P1 | Blossom supporta, non integrato |
| 7.8 | GIF search e invio | tweb Only | P3 | GIF manager esiste, non adattato |
| 7.9 | Sticker invio | tweb Only | P3 | Sticker manager esiste, non adattato |
| 7.10 | Media viewer full-screen | tweb Only | P2 | UI esiste, funzionera' quando media P2P funziona |
| 7.11 | Download/save media | tweb Only | P2 | - |
| 7.12 | Drag & drop file | tweb Only | P3 | UI esiste |

## 8. Gruppi

| # | Feature Telegram | Stato Nostra.chat | Priorita' | Note |
|---|-----------------|-------------------|-----------|------|
| 8.1 | Creare gruppo | P2P Parziale | P1 | GroupAPI esiste, CHECKLIST 7.1 non verificato |
| 8.2 | Inviare messaggio nel gruppo | Missing | P1 | CHECKLIST 7.2 |
| 8.3 | Info sidebar gruppo | Missing | P2 | CHECKLIST 7.3 |
| 8.4 | Aggiungere/rimuovere membri | Missing | P1 | CHECKLIST 7.4 |
| 8.5 | Lasciare gruppo | Missing | P2 | CHECKLIST 7.5 |
| 8.6 | Admin rights management | P2P Parziale | P2 | GroupAPI ha admin designation |
| 8.7 | Group name/description/avatar | tweb Only | P2 | - |
| 8.8 | Permessi membri | tweb Only | P3 | - |
| 8.9 | Menzioni (@user) nel gruppo | tweb Only | P3 | - |

## 9. Canali (Broadcast)

| # | Feature Telegram | Stato Nostra.chat | Priorita' | Note |
|---|-----------------|-------------------|-----------|------|
| 9.1 | Creare canale | Missing | P3 | Potenzialmente via NIP-28 public channels |
| 9.2 | Post nel canale | Missing | P3 | - |
| 9.3 | Subscribers | Missing | P3 | - |
| 9.4 | Commenti ai post | Missing | P4 | - |
| 9.5 | Channel statistics | Missing | P4 | - |

## 10. Chiamate

| # | Feature Telegram | Stato Nostra.chat | Priorita' | Note |
|---|-----------------|-------------------|-----------|------|
| 10.1 | Chiamata voce 1:1 | tweb Only | P2 | WebRTC signaling esiste, non adattato a P2P signaling |
| 10.2 | Videochiamata 1:1 | tweb Only | P2 | - |
| 10.3 | Chiamata gruppo | tweb Only | P3 | AppGroupCallsManager esiste |
| 10.4 | Screen sharing | tweb Only | P3 | - |
| 10.5 | RTMP streaming | tweb Only | P4 | - |

## 11. Notifiche

| # | Feature Telegram | Stato Nostra.chat | Priorita' | Note |
|---|-----------------|-------------------|-----------|------|
| 11.1 | Push notification | tweb Only | P1 | Service Worker esiste, non adattato a P2P |
| 11.2 | Notification sound | tweb Only | P2 | - |
| 11.3 | Mute per chat/gruppo | tweb Only | P2 | - |
| 11.4 | Badge count | tweb Only | P2 | - |
| 11.5 | Notification settings | tweb Only | P2 | UI esiste |

## 12. Privacy & Security

| # | Feature Telegram | Stato Nostra.chat | Priorita' | Note |
|---|-----------------|-------------------|-----------|------|
| 12.1 | E2E encryption (Secret Chat) | P2P OK: NIP-17 Gift-wrap su TUTTI i messaggi | P0 | Verificato — ogni messaggio e' E2E |
| 12.2 | Read receipt toggle | P2P OK | P1 | Verificato E2E (9.1) |
| 12.3 | "Chi puo' aggiungermi ai gruppi" | P2P OK | P1 | Verificato E2E (9.2) |
| 12.4 | Message requests (sconosciuti) | P2P OK | P0 | Verificato E2E (3.5, 9.3) |
| 12.5 | Blocca utente | P2P Parziale | P1 | UI esiste, enforcement P2P da verificare |
| 12.6 | "Chi vede il mio ultimo accesso" | tweb Only | P2 | - |
| 12.7 | "Chi vede la mia foto profilo" | tweb Only | P3 | - |
| 12.8 | Passcode lock | P2P OK | P2 | LockScreen implementato |
| 12.9 | - | Nostra+: Tor privacy transport | P2 | Implementato con fallback |
| 12.10 | - | Nostra+: Seed phrase backup/recovery | P0 | Implementato |
| 12.11 | - | Nostra+: Nessun numero di telefono | P0 | Core |
| 12.12 | - | Nostra+: Protocollo aperto (Nostr) | P0 | Core |
| 12.13 | - | Nostra+: Self-hostable | P2 | Via relay personali |

## 13. Settings & Personalizzazione

| # | Feature Telegram | Stato Nostra.chat | Priorita' | Note |
|---|-----------------|-------------------|-----------|------|
| 13.1 | Tema chiaro/scuro | tweb Only (prob funziona) | P2 | Probabile che funzioni anche in P2P |
| 13.2 | Lingua app | tweb Only (prob funziona) | P2 | AppLangPackManager esiste |
| 13.3 | Dimensione font chat | tweb Only | P3 | - |
| 13.4 | Gestione relay | Nostra+ P2P OK | P1 | Nostra Relay Settings tab |
| 13.5 | Gestione identita' | Nostra+ P2P OK | P0 | Nostra Identity tab |
| 13.6 | Gestione sicurezza chiavi | Nostra+ P2P OK | P0 | Nostra Security tab |
| 13.7 | Status page (Tor + Relay) | P2P OK | P1 | Verificato E2E (10.1-10.9) |
| 13.8 | Data & storage settings | tweb Only | P3 | - |
| 13.9 | Chat folders | tweb Only | P3 | - |
| 13.10 | Archive chats | tweb Only | P3 | - |

## 14. Storie

| # | Feature Telegram | Stato Nostra.chat | Priorita' | Note |
|---|-----------------|-------------------|-----------|------|
| 14.1 | Pubblicare storia | tweb Only | P4 | Non prioritario per MVP P2P |
| 14.2 | Visualizzare storie | tweb Only | P4 | - |
| 14.3 | Privacy storie | tweb Only | P4 | - |

## 15. Bot & Automazione

| # | Feature Telegram | Stato Nostra.chat | Priorita' | Note |
|---|-----------------|-------------------|-----------|------|
| 15.1 | Bot commands | tweb Only | P4 | Modello diverso in Nostr |
| 15.2 | Inline bots | tweb Only | P4 | - |
| 15.3 | Bot payments | N/A | - | - |

## 16. Multi-device & Sync

| # | Feature Telegram | Stato Nostra.chat | Priorita' | Note |
|---|-----------------|-------------------|-----------|------|
| 16.1 | Multi-device sync | P2P Parziale | P2 | Stessa seed phrase su piu' browser, relay backfill |
| 16.2 | Active sessions management | tweb Only | P3 | - |
| 16.3 | Logout remote device | N/A | - | Non applicabile con keypair |

---

## Riepilogo per Priorita'

### P0 — Core (senza queste non e' un messenger)

| Feature | Stato | Gap |
|---------|-------|-----|
| Creare identita' | OK | - |
| Aggiungere contatti | OK | - |
| Inviare/ricevere messaggi 1:1 | OK | - |
| E2E encryption | OK | - |
| Message requests | OK | - |
| Persistenza messaggi | Parziale | 4.5, 4.6 non verificati |
| Elimina messaggi | Parziale | "per tutti" (6.8), ricezione cancellazione (6.9) |
| Inviare foto | Parziale | 8.1 non verificato |

### P1 — Essenziale (utenti se lo aspettano)

| Feature | Stato | Gap |
|---------|-------|-----|
| Kind 0 profile fetch | Non verificato | 1.4 |
| Edit messaggio | tweb Only | Adattare a P2P |
| Reply a messaggio | tweb Only | Adattare a P2P |
| Search nella conversazione | Missing | 2B.1-2B.3 |
| Gruppi P2P | Parziale | 7.1-7.5 tutti non verificati |
| Push notification | tweb Only | Adattare a P2P |
| Elimina chat per l'altro | Missing | 6.13 |
| Nuovo msg → nuova chat | Missing | 6.15 |
| Last seen / presenza | Non verificato | 1.8 |
| Inviare video | Non verificato | 8.2 |
| Inviare documenti | tweb Only | Blossom supporta |
| Doppia spunta (delivered/read) | Parziale | Tracker esiste, UI da verificare |
| Blocco utente enforcement | Parziale | Da verificare in P2P |

### P2 — Importante (migliora l'esperienza)

| Feature | Stato | Gap |
|---------|-------|-----|
| Chiamate voce/video 1:1 | tweb Only | WebRTC signaling via Nostr |
| Forward messaggi | tweb Only | Adattare a P2P |
| Media viewer | tweb Only | Funzionera' con media P2P |
| Typing indicator | tweb Only | Possibile via NIP ephemeral events |
| Multi-device sync | Parziale | Relay backfill esiste |
| Tor privacy | OK | - |
| Temi | tweb Only | Probabilmente funziona gia' |
| Notification sound/badge | tweb Only | - |
| NIP-05 identity | OK | - |

### P3 — Nice-to-have

| Feature | Stato | Gap |
|---------|-------|-----|
| GIF, Sticker | tweb Only | - |
| Voice notes | tweb Only | - |
| Chiamate gruppo | tweb Only | - |
| Chat folders | tweb Only | - |
| Canali broadcast | Missing | NIP-28 potenziale |
| Screen sharing | tweb Only | - |

### P4 — Futuro

| Feature | Stato | Gap |
|---------|-------|-----|
| Storie | tweb Only | - |
| Bot ecosystem | tweb Only | - |
| RTMP streaming | tweb Only | - |
| Channel statistics | Missing | - |

---

## Score Attuale

```
P0:  6/8  completati (75%)
P1:  3/14 completati (21%)
P2:  4/11 completati (36%)
P3:  0/6  completati (0%)
P4:  0/4  completati (0%)
```

**Priorita' immediata:** chiudere i gap P0 e P1 per raggiungere feature parity sulle funzionalita' core.
