/**
 * Invoice attachments to Drive
 *
 * Saves PDF attachments from your invoice senders into one Drive folder
 * (the invoice Inbox), once a day. Each email is saved once.
 * It never deletes, labels, moves or sends any email.
 *
 * Setup: paste this file at https://script.google.com (New project),
 * fill in CONFIG, then run the function "install" once and accept the
 * permissions.
 */

const CONFIG = {
  // Id of the Drive folder "1 - Inbox" (the last part of the folder URL).
  INBOX_FOLDER_ID: 'PASTE_INBOX_FOLDER_ID',

  // Emails received before this date are ignored. Use today's date if the
  // older invoices are already filed, or an earlier date to backfill.
  START_DATE: '2026/01/01',

  // How far back each daily run looks. Must cover the gap since START_DATE
  // on the first run if you want a backfill.
  LOOKBACK_DAYS: 45,

  // Hour of the daily run, in the script's time zone.
  RUN_HOUR: 7,

  // Senders whose PDF attachments are saved. Add or remove freely.
  SENDERS: [
    // 'invoices@supplier.example',
  ],

  // Only used by listInvoiceSenders(). Your own address, and the words
  // that identify your company in an email (name, VAT number).
  MY_ADDRESS: 'you@example.com',
  COMPANY_TERMS: [
    // 'My Company', '0123.456.789',
  ],
};

/** Run this once. It schedules the daily run and does a first pass. */
function install() {
  checkConfig_();
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'saveInvoiceAttachments')
    .forEach((t) => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger('saveInvoiceAttachments')
    .timeBased()
    .everyDays(1)
    .atHour(CONFIG.RUN_HOUR)
    .create();

  saveInvoiceAttachments();
  Logger.log('Installed. Daily run at about ' + String(CONFIG.RUN_HOUR) + ':00.');
}

/** The daily job. */
function saveInvoiceAttachments() {
  checkConfig_();
  const folder = DriveApp.getFolderById(CONFIG.INBOX_FOLDER_ID);
  const props = PropertiesService.getScriptProperties();
  const seen = JSON.parse(props.getProperty('seen') || '{}');
  const startDate = new Date(CONFIG.START_DATE.replace(/\//g, '-') + 'T00:00:00');

  const query =
    'from:(' + CONFIG.SENDERS.join(' OR ') + ') has:attachment' +
    ' newer_than:' + CONFIG.LOOKBACK_DAYS + 'd';

  let saved = 0;
  GmailApp.search(query, 0, 100).forEach((thread) => {
    thread.getMessages().forEach((message) => {
      const id = message.getId();
      if (seen[id]) return;
      if (!isListedSender_(message.getFrom())) return;
      if (message.getDate() < startDate) return;

      pdfAttachments_(message).forEach((attachment) => {
        folder.createFile(attachment.copyBlob()).setName(attachment.getName());
        saved++;
        Logger.log('Saved ' + attachment.getName() + ' (' + message.getFrom() + ')');
      });
      seen[id] = message.getDate().getTime();
    });
  });

  // Forget emails that are older than the search window.
  const cutoff = Date.now() - (CONFIG.LOOKBACK_DAYS + 30) * 24 * 60 * 60 * 1000;
  Object.keys(seen).forEach((id) => {
    if (seen[id] < cutoff) delete seen[id];
  });
  props.setProperty('seen', JSON.stringify(seen));

  Logger.log('Done. ' + String(saved) + ' file(s) saved to the Inbox folder.');
}

/**
 * Optional check. Saves nothing. Lists every matching email of the last
 * 120 days with its PDF names, so you can see what the script can reach.
 */
function previewMatches() {
  checkConfig_();
  const query = 'from:(' + CONFIG.SENDERS.join(' OR ') + ') has:attachment newer_than:120d';
  GmailApp.search(query, 0, 100).forEach((thread) => {
    thread.getMessages().forEach((message) => {
      if (!isListedSender_(message.getFrom())) return;
      const names = pdfAttachments_(message).map((a) => a.getName());
      Logger.log(
        [
          Utilities.formatDate(message.getDate(), Session.getScriptTimeZone(), 'yyyy-MM-dd'),
          message.getFrom(),
          message.getSubject(),
          names.length ? names.join(', ') : '(no PDF)',
        ].join(' | ')
      );
    });
  });
}

/**
 * Optional discovery. Saves nothing and changes nothing.
 * Scans the last 18 months for emails that look like invoices and logs one
 * line per sender, so you can spot suppliers that are missing from SENDERS.
 *
 * Columns: listed | pdf | keyword | company | last seen | sender | last subject
 *   listed   yes when the sender is already in SENDERS
 *   pdf      emails with a PDF attachment
 *   keyword  emails with an invoice word (facture, invoice, factuur, ...)
 *   company  emails that mention one of COMPANY_TERMS
 */
function listInvoiceSenders() {
  const MONTHS = 18;
  const me = String(CONFIG.MY_ADDRESS).trim().toLowerCase();
  const scope = ' newer_than:' + MONTHS + 'm -from:me -in:chats in:anywhere -in:spam';
  const searches = {
    pdf: 'has:attachment filename:pdf',
    keyword:
      '{facture factuur invoice reçu receipt rechnung "avis d\'échéance" ' +
      '"invitation à payer" "avis de paiement" betalingsuitnodiging}',
  };
  if (CONFIG.COMPANY_TERMS.length) {
    searches.company =
      '{' + CONFIG.COMPANY_TERMS.map((term) => '"' + term + '"').join(' ') + '}';
  }

  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - MONTHS);
  const started = Date.now();
  const stats = {};
  let stoppedEarly = false;

  Object.keys(searches).forEach((kind) => {
    const counted = {};
    for (let start = 0; start < 3000 && !stoppedEarly; start += 100) {
      const threads = GmailApp.search(searches[kind] + scope, start, 100);
      if (!threads.length) break;

      GmailApp.getMessagesForThreads(threads).forEach((messages) => {
        messages.forEach((message) => {
          const id = message.getId();
          if (counted[id]) return;
          counted[id] = true;
          if (message.getDate() < cutoff) return;

          const from = String(message.getFrom());
          const match = from.match(/<([^>]+)>/);
          const address = (match ? match[1] : from).trim().toLowerCase();
          if (address === me) return;

          const entry =
            stats[address] ||
            (stats[address] = { pdf: 0, keyword: 0, company: 0, last: 0, subject: '' });
          entry[kind]++;
          const time = message.getDate().getTime();
          if (time > entry.last) {
            entry.last = time;
            entry.subject = message.getSubject();
          }
        });
      });

      if (threads.length < 100) break;
      if (Date.now() - started > 4.5 * 60 * 1000) stoppedEarly = true;
    }
  });

  const zone = Session.getScriptTimeZone();
  const addresses = Object.keys(stats).sort((a, b) => {
    const x = stats[a];
    const y = stats[b];
    return (
      (y.company > 0) - (x.company > 0) ||
      y.pdf + y.keyword - (x.pdf + x.keyword) ||
      y.last - x.last
    );
  });

  Logger.log('listed | pdf | keyword | company | last seen | sender | last subject');
  addresses.slice(0, 250).forEach((address) => {
    const entry = stats[address];
    Logger.log(
      [
        isListedSender_(address) ? 'yes' : 'no',
        String(entry.pdf),
        String(entry.keyword),
        String(entry.company),
        Utilities.formatDate(new Date(entry.last), zone, 'yyyy-MM-dd'),
        address,
        String(entry.subject).slice(0, 70),
      ].join(' | ')
    );
  });
  Logger.log(
    String(addresses.length) + ' sender(s) found.' +
      (stoppedEarly ? ' Stopped early because of the time limit, the list may be partial.' : '')
  );
}

function checkConfig_() {
  if (!CONFIG.INBOX_FOLDER_ID || CONFIG.INBOX_FOLDER_ID.indexOf('PASTE') === 0) {
    throw new Error('Fill in CONFIG.INBOX_FOLDER_ID first.');
  }
  if (!CONFIG.SENDERS.length) {
    throw new Error('Add at least one address to CONFIG.SENDERS first.');
  }
}

function isListedSender_(from) {
  const lower = String(from).toLowerCase();
  return CONFIG.SENDERS.some((sender) => lower.indexOf(sender.toLowerCase()) !== -1);
}

function pdfAttachments_(message) {
  return message
    .getAttachments({ includeInlineImages: false, includeAttachments: true })
    .filter((a) => a.getContentType() === 'application/pdf' || /\.pdf$/i.test(a.getName()));
}
