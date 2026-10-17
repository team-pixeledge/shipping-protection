// The customer-facing claims page and emails, in the customer's language:
// the storefront's language when they file, stored on the claim
// (Claim.locale) for every later page and email. Merchant-facing text (the
// admin, merchant emails, internal notes) stays English.
//
// Placeholders are {name}. t() fills them in; callers escape the result
// (esc() on the claims page, escapeHtml() in emails), never the template.

export const LOCALES = ["en", "de", "fr", "es", "it", "nl", "hi"] as const;
export type Locale = (typeof LOCALES)[number];

/** "fr", "fr-CA", "pt_BR" → a language we have, else English. */
export function claimLocale(raw: string | null | undefined): Locale {
  const base = (raw ?? "").trim().toLowerCase().split(/[-_]/)[0];
  return (LOCALES as readonly string[]).includes(base) ? (base as Locale) : "en";
}

/** The first supported language in an Accept-Language header, else null. */
export function fromAcceptLanguage(header: string | null | undefined): Locale | null {
  for (const part of (header ?? "").split(",")) {
    const tag = part.split(";")[0].trim();
    if (!tag || tag === "*") continue;
    const l = claimLocale(tag);
    if (l !== "en" || tag.toLowerCase().startsWith("en")) return l;
  }
  return null;
}

export const isLocale = (s: unknown): s is Locale => (LOCALES as readonly string[]).includes(s as string);

/** Why a claim can't be filed online. Codes, so the reason can be shown in any language. */
export type RefusalCode =
  | "CANCELLED"
  | "NO_PROTECTION"
  | "OPEN_CLAIM"
  | "ALREADY_CLAIMED"
  | "NOT_SHIPPED"
  | "WINDOW_SHIPPED"
  | "WINDOW_DELIVERED"
  | "LOST_TOO_EARLY"
  | "OVER_ORDER_LIMIT"
  | "OVER_CUSTOMER_LIMIT";

export interface Refusal {
  code: RefusalCode;
  vars?: Record<string, string | number>;
}

type Statuses = { OPEN: string; NEEDS_INFO: string; APPROVED: string; REJECTED: string };
type Types = { LOST: string; STOLEN: string; DAMAGED: string };

export interface Dict {
  pageTitle: string;
  unavailable: string;
  lookupTitle: string;
  lookupIntro: string;
  orderNumber: string;
  orderEmail: string;
  signedInOptional: string;
  findOrder: string;
  alreadyFiled: string;
  orderHeading: string;
  viewOpenClaim: string;
  lookupAnother: string;
  claimFor: string;
  whatHappened: string;
  types: Types;
  typeHelp: Types;
  whichItems: string;
  each: string;
  quantity: string;
  tellUs: string;
  uploadLabel: string;
  uploadRequiredDamage: string;
  uploadRequiredAll: string;
  uploadFormats: string;
  updatesTo: string;
  confirmTrue: string;
  submit: string;
  claimNumber: string;
  claimMeta: string;
  statuses: Statuses;
  resolutions: { REFUND: string; REPLACEMENT: string; STORE_CREDIT: string; OTHER: string };
  totalClaimed: string;
  history: string;
  evFiled: string;
  evStaffFiled: string;
  evResolved: string;
  evStatus: string;
  evYouFiles: string;
  evStoreFiles: string;
  evYouWrote: string;
  evStoreWrote: string;
  replyNeedsInfo: string;
  replyMessage: string;
  addFiles: string;
  send: string;
  closed: string;
  filedOk: string;
  sentOk: string;
  errEnterBoth: string;
  errLookupDown: string;
  errNotFound: string;
  errNoEmail: string;
  errExpired: string;
  errCantLoad: string;
  errChooseType: string;
  errChooseItem: string;
  errDescribe: string;
  errConfirm: string;
  errPhoto: string;
  errDocument: string;
  errBadLink: string;
  errClosed: string;
  errEmpty: string;
  errTooMany: string;
  refusal: Record<RefusalCode, string>;
  upTooMany: string;
  upTooLarge: string;
  upUploading: string;
  upFailed: string;
  upRemove: string;
  mailReceivedTitle: string;
  mailReceivedBody: string;
  mailViewClaim: string;
  mailReply: string;
  mailUpdateTitle: string;
  mailSubject: string;
  mailLead: Statuses;
  mailApprovedWith: string;
  mailResolvedTitle: string;
  mailRefunded: string;
  mailReplacement: string;
  mailStoreCredit: string;
}

const en: Dict = {
  pageTitle: "Shipping protection claims",
  unavailable: "Claims can't be filed online for this store. Please contact the store.",
  lookupTitle: "File a shipping protection claim",
  lookupIntro: "If your package was lost, stolen or arrived damaged, tell us here. First, find your order.",
  orderNumber: "Order number",
  orderEmail: "Email used for the order",
  signedInOptional: "(optional — you're signed in)",
  findOrder: "Find my order",
  alreadyFiled: "Already filed a claim? Use the link in your confirmation email to see its status.",
  orderHeading: "Order {order}",
  viewOpenClaim: "View the open claim",
  lookupAnother: "Look up another order",
  claimFor: "Claim for order {order}",
  whatHappened: "What happened?",
  types: { LOST: "Lost in transit", STOLEN: "Stolen after delivery", DAMAGED: "Arrived damaged" },
  typeHelp: {
    LOST: "The package never arrived and isn't marked delivered, or tracking stopped updating.",
    STOLEN: "The package was marked delivered but you didn't receive it.",
    DAMAGED: "The package arrived but items were broken or damaged. Please add photos.",
  },
  whichItems: "Which items are affected?",
  each: "{price} each",
  quantity: "Quantity",
  tellUs: "Tell us what happened",
  uploadLabel: "Photos or documents",
  uploadRequiredDamage: "required for damage claims",
  uploadRequiredAll: "a photo is required for damage claims, a document (such as a police report) for lost or stolen packages",
  uploadFormats: "JPG, PNG, HEIC or PDF, up to 10 MB each",
  updatesTo: "We'll send updates to {email}.",
  confirmTrue: "The information I've given is true and complete.",
  submit: "Submit claim",
  claimNumber: "Claim {number}",
  claimMeta: "Order {order} · {type} · filed {date}",
  statuses: { OPEN: "In review", NEEDS_INFO: "Needs more information", APPROVED: "Approved", REJECTED: "Not approved" },
  resolutions: { REFUND: "Refund", REPLACEMENT: "Replacement", STORE_CREDIT: "Store credit", OTHER: "Other" },
  totalClaimed: "Total claimed",
  history: "History",
  evFiled: "Claim filed",
  evStaffFiled: "Claim created by the store",
  evResolved: "Resolved",
  evStatus: "Status: {status}",
  evYouFiles: "You added files",
  evStoreFiles: "The store added files",
  evYouWrote: "You wrote",
  evStoreWrote: "The store wrote",
  replyNeedsInfo: "Send the information requested",
  replyMessage: "Add a message for the store",
  addFiles: "Add photos or documents",
  send: "Send",
  closed: "This claim is closed. If you have questions, reply to the email you received or contact the store.",
  filedOk: "Thanks — your claim has been filed. We've emailed you a confirmation with a link to this page.",
  sentOk: "Sent — the store will be in touch.",
  errEnterBoth: "Enter your order number and email.",
  errLookupDown: "We can't look up orders right now. Please try again later or contact the store.",
  errNotFound: "We couldn't find an order with that number and email. Check both and try again.",
  errNoEmail: "This order has no email address, so we can't send claim updates. Please contact the store.",
  errExpired: "This page expired. Please find your order again.",
  errCantLoad: "We couldn't load this order. Please contact the store.",
  errChooseType: "Choose what happened to your package.",
  errChooseItem: "Choose at least one affected item.",
  errDescribe: "Please describe what happened (at least a sentence).",
  errConfirm: "Please confirm the information is true.",
  errPhoto: "Please add at least one photo of the damage.",
  errDocument: "Please add a supporting document, such as a police report or a carrier's reply.",
  errBadLink: "This link isn't valid any more. Use the link in your most recent email, or contact the store.",
  errClosed: "This claim is closed. Please contact the store.",
  errEmpty: "Write a message or add a file.",
  errTooMany: "Too many attempts. Please wait 15 minutes and try again.",
  refusal: {
    CANCELLED: "This order was cancelled, so it can't be claimed.",
    NO_PROTECTION: "This order didn't include shipping protection, so it can't be claimed here.",
    OPEN_CLAIM: "There's already an open claim for this order.",
    ALREADY_CLAIMED: "This order has already been claimed. Please contact the store.",
    NOT_SHIPPED: "This order hasn't shipped yet. You can file a claim once it's on its way.",
    WINDOW_SHIPPED: "Claims must be filed within {days} days of shipping. Please contact the store.",
    WINDOW_DELIVERED: "Claims must be filed within {days} days of delivery. Please contact the store.",
    LOST_TOO_EARLY: "Packages can be reported lost {days} days after shipping — from {date}. It may still be on its way.",
    OVER_ORDER_LIMIT: "This claim is more than can be claimed online for one order. Please contact the store.",
    OVER_CUSTOMER_LIMIT: "This claim is more than can be claimed online. Please contact the store.",
  },
  upTooMany: "{name}: too many files ({max} at most)",
  upTooLarge: "{name}: too large (10 MB at most)",
  upUploading: "Uploading {name}…",
  upFailed: "{name}: upload failed — try again",
  upRemove: "Remove",
  mailReceivedTitle: "We've received your claim {number}",
  mailReceivedBody: "We've received your claim for order {order}. We'll review it and email you when there's an update.",
  mailViewClaim: "View your claim",
  mailReply: "Reply to the store",
  mailUpdateTitle: "Claim {number}: {status}",
  mailSubject: "{title} (order {order})",
  mailLead: {
    OPEN: "Your claim {number} for order {order} is being reviewed.",
    NEEDS_INFO: "We need a little more information to review your claim {number} for order {order}. Please reply using the link below.",
    APPROVED: "Good news: your claim {number} for order {order} has been approved.",
    REJECTED: "We've reviewed your claim {number} for order {order} and weren't able to approve it.",
  },
  mailApprovedWith: "Good news: your claim {number} for order {order} has been approved ({resolution}).",
  mailResolvedTitle: "Claim {number}: resolved",
  mailRefunded: "We've refunded {amount} to your original payment method. It can take a few business days to appear.",
  mailReplacement: "We're sending you a replacement at no charge: order {replacement}. You'll get the usual shipping emails when it's on its way.",
  mailStoreCredit: "We've added {amount} of store credit to your account. It's applied at checkout when you're signed in.",
};

const de: Dict = {
  pageTitle: "Reklamationen zum Versandschutz",
  unavailable: "Für diesen Shop können Reklamationen nicht online eingereicht werden. Bitte wende dich an den Shop.",
  lookupTitle: "Versandschutz-Reklamation einreichen",
  lookupIntro: "Wenn dein Paket verloren gegangen, gestohlen oder beschädigt angekommen ist, melde es hier. Suche zuerst deine Bestellung.",
  orderNumber: "Bestellnummer",
  orderEmail: "E-Mail-Adresse der Bestellung",
  signedInOptional: "(optional — du bist angemeldet)",
  findOrder: "Bestellung suchen",
  alreadyFiled: "Schon eine Reklamation eingereicht? Den Status siehst du über den Link in deiner Bestätigungs-E-Mail.",
  orderHeading: "Bestellung {order}",
  viewOpenClaim: "Offene Reklamation ansehen",
  lookupAnother: "Andere Bestellung suchen",
  claimFor: "Reklamation zu Bestellung {order}",
  whatHappened: "Was ist passiert?",
  types: { LOST: "Unterwegs verloren gegangen", STOLEN: "Nach der Zustellung gestohlen", DAMAGED: "Beschädigt angekommen" },
  typeHelp: {
    LOST: "Das Paket ist nie angekommen und nicht als zugestellt markiert, oder die Sendungsverfolgung wird nicht mehr aktualisiert.",
    STOLEN: "Das Paket wurde als zugestellt markiert, aber du hast es nicht erhalten.",
    DAMAGED: "Das Paket ist angekommen, aber Artikel waren kaputt oder beschädigt. Bitte füge Fotos hinzu.",
  },
  whichItems: "Welche Artikel sind betroffen?",
  each: "{price} pro Stück",
  quantity: "Menge",
  tellUs: "Beschreibe, was passiert ist",
  uploadLabel: "Fotos oder Dokumente",
  uploadRequiredDamage: "bei Beschädigungen erforderlich",
  uploadRequiredAll: "bei Beschädigungen ist ein Foto erforderlich, bei verlorenen oder gestohlenen Paketen ein Dokument (z. B. eine Anzeige bei der Polizei)",
  uploadFormats: "JPG, PNG, HEIC oder PDF, je bis zu 10 MB",
  updatesTo: "Updates schicken wir an {email}.",
  confirmTrue: "Meine Angaben sind wahr und vollständig.",
  submit: "Reklamation einreichen",
  claimNumber: "Reklamation {number}",
  claimMeta: "Bestellung {order} · {type} · eingereicht am {date}",
  statuses: { OPEN: "In Prüfung", NEEDS_INFO: "Weitere Angaben nötig", APPROVED: "Genehmigt", REJECTED: "Nicht genehmigt" },
  resolutions: { REFUND: "Erstattung", REPLACEMENT: "Ersatzlieferung", STORE_CREDIT: "Guthaben", OTHER: "Sonstiges" },
  totalClaimed: "Reklamierter Betrag",
  history: "Verlauf",
  evFiled: "Reklamation eingereicht",
  evStaffFiled: "Reklamation vom Shop angelegt",
  evResolved: "Erledigt",
  evStatus: "Status: {status}",
  evYouFiles: "Du hast Dateien hinzugefügt",
  evStoreFiles: "Der Shop hat Dateien hinzugefügt",
  evYouWrote: "Du hast geschrieben",
  evStoreWrote: "Der Shop hat geschrieben",
  replyNeedsInfo: "Angeforderte Informationen senden",
  replyMessage: "Nachricht an den Shop",
  addFiles: "Fotos oder Dokumente hinzufügen",
  send: "Senden",
  closed: "Diese Reklamation ist abgeschlossen. Bei Fragen antworte auf die erhaltene E-Mail oder wende dich an den Shop.",
  filedOk: "Danke — deine Reklamation ist eingegangen. Wir haben dir eine Bestätigung mit einem Link zu dieser Seite geschickt.",
  sentOk: "Gesendet — der Shop meldet sich bei dir.",
  errEnterBoth: "Gib deine Bestellnummer und E-Mail-Adresse ein.",
  errLookupDown: "Bestellungen können gerade nicht gesucht werden. Bitte versuche es später noch einmal oder wende dich an den Shop.",
  errNotFound: "Wir haben keine Bestellung mit dieser Nummer und E-Mail-Adresse gefunden. Prüfe beides und versuche es erneut.",
  errNoEmail: "Diese Bestellung hat keine E-Mail-Adresse, daher können wir keine Updates senden. Bitte wende dich an den Shop.",
  errExpired: "Diese Seite ist abgelaufen. Bitte suche deine Bestellung erneut.",
  errCantLoad: "Diese Bestellung konnte nicht geladen werden. Bitte wende dich an den Shop.",
  errChooseType: "Wähle aus, was mit deinem Paket passiert ist.",
  errChooseItem: "Wähle mindestens einen betroffenen Artikel aus.",
  errDescribe: "Bitte beschreibe, was passiert ist (mindestens einen Satz).",
  errConfirm: "Bitte bestätige, dass deine Angaben stimmen.",
  errPhoto: "Bitte füge mindestens ein Foto des Schadens hinzu.",
  errDocument: "Bitte füge ein Dokument hinzu, z. B. eine Anzeige bei der Polizei oder eine Antwort des Versanddienstleisters.",
  errBadLink: "Dieser Link ist nicht mehr gültig. Nutze den Link aus deiner neuesten E-Mail oder wende dich an den Shop.",
  errClosed: "Diese Reklamation ist abgeschlossen. Bitte wende dich an den Shop.",
  errEmpty: "Schreibe eine Nachricht oder füge eine Datei hinzu.",
  errTooMany: "Zu viele Versuche. Bitte warte 15 Minuten und versuche es dann erneut.",
  refusal: {
    CANCELLED: "Diese Bestellung wurde storniert und kann nicht reklamiert werden.",
    NO_PROTECTION: "Diese Bestellung enthielt keinen Versandschutz und kann hier nicht reklamiert werden.",
    OPEN_CLAIM: "Zu dieser Bestellung gibt es bereits eine offene Reklamation.",
    ALREADY_CLAIMED: "Diese Bestellung wurde bereits reklamiert. Bitte wende dich an den Shop.",
    NOT_SHIPPED: "Diese Bestellung wurde noch nicht versendet. Du kannst reklamieren, sobald sie unterwegs ist.",
    WINDOW_SHIPPED: "Reklamationen müssen innerhalb von {days} Tagen nach dem Versand eingereicht werden. Bitte wende dich an den Shop.",
    WINDOW_DELIVERED: "Reklamationen müssen innerhalb von {days} Tagen nach der Zustellung eingereicht werden. Bitte wende dich an den Shop.",
    LOST_TOO_EARLY: "Pakete können {days} Tage nach dem Versand als verloren gemeldet werden — ab {date}. Es ist vielleicht noch unterwegs.",
    OVER_ORDER_LIMIT: "Diese Reklamation übersteigt den Betrag, der pro Bestellung online reklamiert werden kann. Bitte wende dich an den Shop.",
    OVER_CUSTOMER_LIMIT: "Diese Reklamation übersteigt den Betrag, der online reklamiert werden kann. Bitte wende dich an den Shop.",
  },
  upTooMany: "{name}: zu viele Dateien (höchstens {max})",
  upTooLarge: "{name}: zu groß (höchstens 10 MB)",
  upUploading: "{name} wird hochgeladen…",
  upFailed: "{name}: Hochladen fehlgeschlagen — bitte erneut versuchen",
  upRemove: "Entfernen",
  mailReceivedTitle: "Wir haben deine Reklamation {number} erhalten",
  mailReceivedBody: "Wir haben deine Reklamation zu Bestellung {order} erhalten. Wir prüfen sie und melden uns per E-Mail, sobald es Neuigkeiten gibt.",
  mailViewClaim: "Reklamation ansehen",
  mailReply: "Dem Shop antworten",
  mailUpdateTitle: "Reklamation {number}: {status}",
  mailSubject: "{title} (Bestellung {order})",
  mailLead: {
    OPEN: "Deine Reklamation {number} zu Bestellung {order} wird geprüft.",
    NEEDS_INFO: "Für die Prüfung deiner Reklamation {number} zu Bestellung {order} brauchen wir noch ein paar Angaben. Bitte antworte über den Link unten.",
    APPROVED: "Gute Nachrichten: Deine Reklamation {number} zu Bestellung {order} wurde genehmigt.",
    REJECTED: "Wir haben deine Reklamation {number} zu Bestellung {order} geprüft und können sie leider nicht genehmigen.",
  },
  mailApprovedWith: "Gute Nachrichten: Deine Reklamation {number} zu Bestellung {order} wurde genehmigt ({resolution}).",
  mailResolvedTitle: "Reklamation {number}: erledigt",
  mailRefunded: "Wir haben {amount} auf deine ursprüngliche Zahlungsart erstattet. Es kann ein paar Werktage dauern, bis der Betrag erscheint.",
  mailReplacement: "Wir schicken dir kostenlos Ersatz: Bestellung {replacement}. Du bekommst die üblichen Versand-E-Mails, sobald sie unterwegs ist.",
  mailStoreCredit: "Wir haben deinem Kundenkonto {amount} Guthaben gutgeschrieben. Es wird an der Kasse angerechnet, wenn du angemeldet bist.",
};

const fr: Dict = {
  pageTitle: "Réclamations de protection d'expédition",
  unavailable: "Les réclamations ne peuvent pas être déposées en ligne pour cette boutique. Veuillez contacter la boutique.",
  lookupTitle: "Déposer une réclamation de protection d'expédition",
  lookupIntro: "Si votre colis a été perdu, volé ou est arrivé endommagé, signalez-le ici. Commencez par retrouver votre commande.",
  orderNumber: "Numéro de commande",
  orderEmail: "E-mail utilisé pour la commande",
  signedInOptional: "(facultatif — vous êtes connecté)",
  findOrder: "Trouver ma commande",
  alreadyFiled: "Vous avez déjà déposé une réclamation ? Suivez-la grâce au lien de votre e-mail de confirmation.",
  orderHeading: "Commande {order}",
  viewOpenClaim: "Voir la réclamation en cours",
  lookupAnother: "Rechercher une autre commande",
  claimFor: "Réclamation pour la commande {order}",
  whatHappened: "Que s'est-il passé ?",
  types: { LOST: "Perdu pendant le transport", STOLEN: "Volé après la livraison", DAMAGED: "Arrivé endommagé" },
  typeHelp: {
    LOST: "Le colis n'est jamais arrivé et n'est pas indiqué comme livré, ou le suivi ne se met plus à jour.",
    STOLEN: "Le colis est indiqué comme livré, mais vous ne l'avez pas reçu.",
    DAMAGED: "Le colis est arrivé, mais des articles étaient cassés ou endommagés. Merci d'ajouter des photos.",
  },
  whichItems: "Quels articles sont concernés ?",
  each: "{price} l'unité",
  quantity: "Quantité",
  tellUs: "Expliquez-nous ce qui s'est passé",
  uploadLabel: "Photos ou documents",
  uploadRequiredDamage: "obligatoires pour un colis endommagé",
  uploadRequiredAll: "une photo est obligatoire pour un colis endommagé, un document (par exemple un dépôt de plainte) pour un colis perdu ou volé",
  uploadFormats: "JPG, PNG, HEIC ou PDF, 10 Mo maximum chacun",
  updatesTo: "Nous enverrons les mises à jour à {email}.",
  confirmTrue: "Les informations fournies sont exactes et complètes.",
  submit: "Envoyer la réclamation",
  claimNumber: "Réclamation {number}",
  claimMeta: "Commande {order} · {type} · déposée le {date}",
  statuses: { OPEN: "En cours d'examen", NEEDS_INFO: "Informations requises", APPROVED: "Acceptée", REJECTED: "Refusée" },
  resolutions: { REFUND: "Remboursement", REPLACEMENT: "Remplacement", STORE_CREDIT: "Avoir", OTHER: "Autre" },
  totalClaimed: "Montant réclamé",
  history: "Historique",
  evFiled: "Réclamation déposée",
  evStaffFiled: "Réclamation créée par la boutique",
  evResolved: "Résolue",
  evStatus: "Statut : {status}",
  evYouFiles: "Vous avez ajouté des fichiers",
  evStoreFiles: "La boutique a ajouté des fichiers",
  evYouWrote: "Vous avez écrit",
  evStoreWrote: "La boutique a écrit",
  replyNeedsInfo: "Envoyer les informations demandées",
  replyMessage: "Ajouter un message pour la boutique",
  addFiles: "Ajouter des photos ou des documents",
  send: "Envoyer",
  closed: "Cette réclamation est close. Pour toute question, répondez à l'e-mail reçu ou contactez la boutique.",
  filedOk: "Merci — votre réclamation a été déposée. Nous vous avons envoyé une confirmation avec un lien vers cette page.",
  sentOk: "Envoyé — la boutique reviendra vers vous.",
  errEnterBoth: "Saisissez votre numéro de commande et votre e-mail.",
  errLookupDown: "Impossible de rechercher les commandes pour le moment. Réessayez plus tard ou contactez la boutique.",
  errNotFound: "Aucune commande ne correspond à ce numéro et à cet e-mail. Vérifiez-les et réessayez.",
  errNoEmail: "Cette commande n'a pas d'adresse e-mail, nous ne pouvons donc pas envoyer de mises à jour. Veuillez contacter la boutique.",
  errExpired: "Cette page a expiré. Veuillez rechercher à nouveau votre commande.",
  errCantLoad: "Impossible de charger cette commande. Veuillez contacter la boutique.",
  errChooseType: "Indiquez ce qui est arrivé à votre colis.",
  errChooseItem: "Choisissez au moins un article concerné.",
  errDescribe: "Décrivez ce qui s'est passé (au moins une phrase).",
  errConfirm: "Veuillez confirmer que les informations sont exactes.",
  errPhoto: "Ajoutez au moins une photo des dégâts.",
  errDocument: "Ajoutez un justificatif, par exemple un dépôt de plainte ou la réponse du transporteur.",
  errBadLink: "Ce lien n'est plus valide. Utilisez le lien de votre e-mail le plus récent ou contactez la boutique.",
  errClosed: "Cette réclamation est close. Veuillez contacter la boutique.",
  errEmpty: "Écrivez un message ou ajoutez un fichier.",
  errTooMany: "Trop de tentatives. Veuillez patienter 15 minutes puis réessayer.",
  refusal: {
    CANCELLED: "Cette commande a été annulée et ne peut donc pas faire l'objet d'une réclamation.",
    NO_PROTECTION: "Cette commande ne comprenait pas de protection d'expédition et ne peut donc pas faire l'objet d'une réclamation ici.",
    OPEN_CLAIM: "Une réclamation est déjà en cours pour cette commande.",
    ALREADY_CLAIMED: "Cette commande a déjà fait l'objet d'une réclamation. Veuillez contacter la boutique.",
    NOT_SHIPPED: "Cette commande n'a pas encore été expédiée. Vous pourrez déposer une réclamation dès qu'elle sera en route.",
    WINDOW_SHIPPED: "Les réclamations doivent être déposées dans les {days} jours suivant l'expédition. Veuillez contacter la boutique.",
    WINDOW_DELIVERED: "Les réclamations doivent être déposées dans les {days} jours suivant la livraison. Veuillez contacter la boutique.",
    LOST_TOO_EARLY: "Un colis peut être déclaré perdu {days} jours après l'expédition, à partir du {date}. Il est peut-être encore en route.",
    OVER_ORDER_LIMIT: "Cette réclamation dépasse le montant pouvant être réclamé en ligne pour une commande. Veuillez contacter la boutique.",
    OVER_CUSTOMER_LIMIT: "Cette réclamation dépasse le montant pouvant être réclamé en ligne. Veuillez contacter la boutique.",
  },
  upTooMany: "{name} : trop de fichiers ({max} maximum)",
  upTooLarge: "{name} : trop volumineux (10 Mo maximum)",
  upUploading: "Envoi de {name}…",
  upFailed: "{name} : échec de l'envoi — réessayez",
  upRemove: "Retirer",
  mailReceivedTitle: "Nous avons bien reçu votre réclamation {number}",
  mailReceivedBody: "Nous avons bien reçu votre réclamation pour la commande {order}. Nous allons l'examiner et vous écrirons dès qu'il y aura du nouveau.",
  mailViewClaim: "Voir votre réclamation",
  mailReply: "Répondre à la boutique",
  mailUpdateTitle: "Réclamation {number} : {status}",
  mailSubject: "{title} (commande {order})",
  mailLead: {
    OPEN: "Votre réclamation {number} pour la commande {order} est en cours d'examen.",
    NEEDS_INFO: "Nous avons besoin de quelques informations supplémentaires pour examiner votre réclamation {number} pour la commande {order}. Merci de répondre via le lien ci-dessous.",
    APPROVED: "Bonne nouvelle : votre réclamation {number} pour la commande {order} a été acceptée.",
    REJECTED: "Nous avons examiné votre réclamation {number} pour la commande {order} et ne sommes pas en mesure de l'accepter.",
  },
  mailApprovedWith: "Bonne nouvelle : votre réclamation {number} pour la commande {order} a été acceptée ({resolution}).",
  mailResolvedTitle: "Réclamation {number} : résolue",
  mailRefunded: "Nous avons remboursé {amount} sur votre moyen de paiement d'origine. Le montant peut mettre quelques jours ouvrés à apparaître.",
  mailReplacement: "Nous vous envoyons un remplacement gratuitement : commande {replacement}. Vous recevrez les e-mails d'expédition habituels dès son envoi.",
  mailStoreCredit: "Nous avons ajouté un avoir de {amount} à votre compte. Il s'applique au paiement lorsque vous êtes connecté.",
};

const es: Dict = {
  pageTitle: "Reclamaciones de protección de envío",
  unavailable: "En esta tienda no se pueden presentar reclamaciones en línea. Ponte en contacto con la tienda.",
  lookupTitle: "Presentar una reclamación de protección de envío",
  lookupIntro: "Si tu paquete se perdió, fue robado o llegó dañado, cuéntanoslo aquí. Primero, busca tu pedido.",
  orderNumber: "Número de pedido",
  orderEmail: "Correo electrónico del pedido",
  signedInOptional: "(opcional: has iniciado sesión)",
  findOrder: "Buscar mi pedido",
  alreadyFiled: "¿Ya presentaste una reclamación? Consulta su estado con el enlace de tu correo de confirmación.",
  orderHeading: "Pedido {order}",
  viewOpenClaim: "Ver la reclamación abierta",
  lookupAnother: "Buscar otro pedido",
  claimFor: "Reclamación del pedido {order}",
  whatHappened: "¿Qué ha pasado?",
  types: { LOST: "Perdido en tránsito", STOLEN: "Robado tras la entrega", DAMAGED: "Llegó dañado" },
  typeHelp: {
    LOST: "El paquete nunca llegó y no figura como entregado, o el seguimiento dejó de actualizarse.",
    STOLEN: "El paquete figura como entregado, pero no lo recibiste.",
    DAMAGED: "El paquete llegó, pero había artículos rotos o dañados. Añade fotos, por favor.",
  },
  whichItems: "¿Qué artículos están afectados?",
  each: "{price} cada uno",
  quantity: "Cantidad",
  tellUs: "Cuéntanos qué ha pasado",
  uploadLabel: "Fotos o documentos",
  uploadRequiredDamage: "obligatorias para daños",
  uploadRequiredAll: "se requiere una foto para daños y un documento (por ejemplo, una denuncia) para paquetes perdidos o robados",
  uploadFormats: "JPG, PNG, HEIC o PDF, hasta 10 MB cada uno",
  updatesTo: "Te enviaremos las novedades a {email}.",
  confirmTrue: "La información que he dado es verdadera y completa.",
  submit: "Enviar reclamación",
  claimNumber: "Reclamación {number}",
  claimMeta: "Pedido {order} · {type} · presentada el {date}",
  statuses: { OPEN: "En revisión", NEEDS_INFO: "Se necesita más información", APPROVED: "Aprobada", REJECTED: "No aprobada" },
  resolutions: { REFUND: "Reembolso", REPLACEMENT: "Reposición", STORE_CREDIT: "Crédito en tienda", OTHER: "Otra" },
  totalClaimed: "Total reclamado",
  history: "Historial",
  evFiled: "Reclamación presentada",
  evStaffFiled: "Reclamación creada por la tienda",
  evResolved: "Resuelta",
  evStatus: "Estado: {status}",
  evYouFiles: "Añadiste archivos",
  evStoreFiles: "La tienda añadió archivos",
  evYouWrote: "Escribiste",
  evStoreWrote: "La tienda escribió",
  replyNeedsInfo: "Enviar la información solicitada",
  replyMessage: "Añadir un mensaje para la tienda",
  addFiles: "Añadir fotos o documentos",
  send: "Enviar",
  closed: "Esta reclamación está cerrada. Si tienes preguntas, responde al correo que recibiste o contacta con la tienda.",
  filedOk: "Gracias: tu reclamación se ha presentado. Te hemos enviado una confirmación con un enlace a esta página.",
  sentOk: "Enviado: la tienda se pondrá en contacto contigo.",
  errEnterBoth: "Introduce tu número de pedido y tu correo electrónico.",
  errLookupDown: "Ahora mismo no podemos buscar pedidos. Inténtalo más tarde o contacta con la tienda.",
  errNotFound: "No encontramos ningún pedido con ese número y correo. Compruébalos e inténtalo de nuevo.",
  errNoEmail: "Este pedido no tiene correo electrónico, así que no podemos enviar novedades. Contacta con la tienda.",
  errExpired: "Esta página ha caducado. Vuelve a buscar tu pedido.",
  errCantLoad: "No pudimos cargar este pedido. Contacta con la tienda.",
  errChooseType: "Elige qué le pasó a tu paquete.",
  errChooseItem: "Elige al menos un artículo afectado.",
  errDescribe: "Describe lo que pasó (al menos una frase).",
  errConfirm: "Confirma que la información es verdadera.",
  errPhoto: "Añade al menos una foto del daño.",
  errDocument: "Añade un documento justificativo, como una denuncia o la respuesta del transportista.",
  errBadLink: "Este enlace ya no es válido. Usa el enlace de tu correo más reciente o contacta con la tienda.",
  errClosed: "Esta reclamación está cerrada. Contacta con la tienda.",
  errEmpty: "Escribe un mensaje o añade un archivo.",
  errTooMany: "Demasiados intentos. Espera 15 minutos y vuelve a intentarlo.",
  refusal: {
    CANCELLED: "Este pedido se canceló, así que no se puede reclamar.",
    NO_PROTECTION: "Este pedido no incluía protección de envío, así que no se puede reclamar aquí.",
    OPEN_CLAIM: "Ya hay una reclamación abierta para este pedido.",
    ALREADY_CLAIMED: "Este pedido ya se ha reclamado. Contacta con la tienda.",
    NOT_SHIPPED: "Este pedido aún no se ha enviado. Podrás presentar una reclamación cuando esté en camino.",
    WINDOW_SHIPPED: "Las reclamaciones deben presentarse en los {days} días siguientes al envío. Contacta con la tienda.",
    WINDOW_DELIVERED: "Las reclamaciones deben presentarse en los {days} días siguientes a la entrega. Contacta con la tienda.",
    LOST_TOO_EARLY: "Un paquete puede declararse perdido {days} días después del envío, a partir del {date}. Puede que aún esté en camino.",
    OVER_ORDER_LIMIT: "Esta reclamación supera lo que se puede reclamar en línea por pedido. Contacta con la tienda.",
    OVER_CUSTOMER_LIMIT: "Esta reclamación supera lo que se puede reclamar en línea. Contacta con la tienda.",
  },
  upTooMany: "{name}: demasiados archivos ({max} como máximo)",
  upTooLarge: "{name}: demasiado grande (10 MB como máximo)",
  upUploading: "Subiendo {name}…",
  upFailed: "{name}: no se pudo subir; inténtalo de nuevo",
  upRemove: "Quitar",
  mailReceivedTitle: "Hemos recibido tu reclamación {number}",
  mailReceivedBody: "Hemos recibido tu reclamación del pedido {order}. La revisaremos y te escribiremos cuando haya novedades.",
  mailViewClaim: "Ver tu reclamación",
  mailReply: "Responder a la tienda",
  mailUpdateTitle: "Reclamación {number}: {status}",
  mailSubject: "{title} (pedido {order})",
  mailLead: {
    OPEN: "Tu reclamación {number} del pedido {order} está en revisión.",
    NEEDS_INFO: "Necesitamos algo más de información para revisar tu reclamación {number} del pedido {order}. Responde con el enlace de abajo.",
    APPROVED: "Buenas noticias: tu reclamación {number} del pedido {order} ha sido aprobada.",
    REJECTED: "Hemos revisado tu reclamación {number} del pedido {order} y no hemos podido aprobarla.",
  },
  mailApprovedWith: "Buenas noticias: tu reclamación {number} del pedido {order} ha sido aprobada ({resolution}).",
  mailResolvedTitle: "Reclamación {number}: resuelta",
  mailRefunded: "Te hemos reembolsado {amount} en tu método de pago original. Puede tardar unos días hábiles en aparecer.",
  mailReplacement: "Te enviamos una reposición sin coste: pedido {replacement}. Recibirás los correos de envío habituales cuando esté en camino.",
  mailStoreCredit: "Hemos añadido {amount} de crédito en tienda a tu cuenta. Se aplica al pagar cuando inicias sesión.",
};

const it: Dict = {
  pageTitle: "Reclami per la protezione della spedizione",
  unavailable: "Per questo negozio non è possibile presentare reclami online. Contatta il negozio.",
  lookupTitle: "Presenta un reclamo per la protezione della spedizione",
  lookupIntro: "Se il tuo pacco è andato perso, è stato rubato o è arrivato danneggiato, segnalalo qui. Per prima cosa, trova il tuo ordine.",
  orderNumber: "Numero d'ordine",
  orderEmail: "Email usata per l'ordine",
  signedInOptional: "(facoltativa: hai effettuato l'accesso)",
  findOrder: "Trova il mio ordine",
  alreadyFiled: "Hai già presentato un reclamo? Segui lo stato con il link nell'email di conferma.",
  orderHeading: "Ordine {order}",
  viewOpenClaim: "Vedi il reclamo aperto",
  lookupAnother: "Cerca un altro ordine",
  claimFor: "Reclamo per l'ordine {order}",
  whatHappened: "Cosa è successo?",
  types: { LOST: "Perso durante il trasporto", STOLEN: "Rubato dopo la consegna", DAMAGED: "Arrivato danneggiato" },
  typeHelp: {
    LOST: "Il pacco non è mai arrivato e non risulta consegnato, oppure il tracciamento non si aggiorna più.",
    STOLEN: "Il pacco risulta consegnato, ma non l'hai ricevuto.",
    DAMAGED: "Il pacco è arrivato, ma alcuni articoli erano rotti o danneggiati. Aggiungi delle foto.",
  },
  whichItems: "Quali articoli sono interessati?",
  each: "{price} cad.",
  quantity: "Quantità",
  tellUs: "Raccontaci cosa è successo",
  uploadLabel: "Foto o documenti",
  uploadRequiredDamage: "obbligatorie per i danni",
  uploadRequiredAll: "serve una foto per i danni e un documento (ad esempio una denuncia) per i pacchi persi o rubati",
  uploadFormats: "JPG, PNG, HEIC o PDF, massimo 10 MB ciascuno",
  updatesTo: "Invieremo gli aggiornamenti a {email}.",
  confirmTrue: "Le informazioni fornite sono vere e complete.",
  submit: "Invia il reclamo",
  claimNumber: "Reclamo {number}",
  claimMeta: "Ordine {order} · {type} · presentato il {date}",
  statuses: { OPEN: "In revisione", NEEDS_INFO: "Servono altre informazioni", APPROVED: "Approvato", REJECTED: "Non approvato" },
  resolutions: { REFUND: "Rimborso", REPLACEMENT: "Sostituzione", STORE_CREDIT: "Credito del negozio", OTHER: "Altro" },
  totalClaimed: "Totale richiesto",
  history: "Cronologia",
  evFiled: "Reclamo presentato",
  evStaffFiled: "Reclamo creato dal negozio",
  evResolved: "Risolto",
  evStatus: "Stato: {status}",
  evYouFiles: "Hai aggiunto dei file",
  evStoreFiles: "Il negozio ha aggiunto dei file",
  evYouWrote: "Hai scritto",
  evStoreWrote: "Il negozio ha scritto",
  replyNeedsInfo: "Invia le informazioni richieste",
  replyMessage: "Aggiungi un messaggio per il negozio",
  addFiles: "Aggiungi foto o documenti",
  send: "Invia",
  closed: "Questo reclamo è chiuso. Per domande, rispondi all'email ricevuta o contatta il negozio.",
  filedOk: "Grazie, il tuo reclamo è stato presentato. Ti abbiamo inviato una conferma con un link a questa pagina.",
  sentOk: "Inviato: il negozio ti contatterà.",
  errEnterBoth: "Inserisci il numero d'ordine e l'email.",
  errLookupDown: "Al momento non possiamo cercare gli ordini. Riprova più tardi o contatta il negozio.",
  errNotFound: "Non abbiamo trovato un ordine con questo numero e questa email. Controllali e riprova.",
  errNoEmail: "Questo ordine non ha un indirizzo email, quindi non possiamo inviare aggiornamenti. Contatta il negozio.",
  errExpired: "Questa pagina è scaduta. Cerca di nuovo il tuo ordine.",
  errCantLoad: "Non siamo riusciti a caricare questo ordine. Contatta il negozio.",
  errChooseType: "Scegli cosa è successo al tuo pacco.",
  errChooseItem: "Scegli almeno un articolo interessato.",
  errDescribe: "Descrivi cosa è successo (almeno una frase).",
  errConfirm: "Conferma che le informazioni sono vere.",
  errPhoto: "Aggiungi almeno una foto del danno.",
  errDocument: "Aggiungi un documento a supporto, ad esempio una denuncia o la risposta del corriere.",
  errBadLink: "Questo link non è più valido. Usa il link dell'email più recente o contatta il negozio.",
  errClosed: "Questo reclamo è chiuso. Contatta il negozio.",
  errEmpty: "Scrivi un messaggio o aggiungi un file.",
  errTooMany: "Troppi tentativi. Attendi 15 minuti e riprova.",
  refusal: {
    CANCELLED: "Questo ordine è stato annullato, quindi non è possibile presentare un reclamo.",
    NO_PROTECTION: "Questo ordine non includeva la protezione della spedizione, quindi non è possibile presentare un reclamo qui.",
    OPEN_CLAIM: "Per questo ordine c'è già un reclamo aperto.",
    ALREADY_CLAIMED: "Per questo ordine è già stato presentato un reclamo. Contatta il negozio.",
    NOT_SHIPPED: "Questo ordine non è ancora stato spedito. Potrai presentare un reclamo quando sarà in viaggio.",
    WINDOW_SHIPPED: "I reclami vanno presentati entro {days} giorni dalla spedizione. Contatta il negozio.",
    WINDOW_DELIVERED: "I reclami vanno presentati entro {days} giorni dalla consegna. Contatta il negozio.",
    LOST_TOO_EARLY: "Un pacco può essere segnalato come perso {days} giorni dopo la spedizione, dal {date}. Potrebbe essere ancora in viaggio.",
    OVER_ORDER_LIMIT: "Questo reclamo supera l'importo richiedibile online per un ordine. Contatta il negozio.",
    OVER_CUSTOMER_LIMIT: "Questo reclamo supera l'importo richiedibile online. Contatta il negozio.",
  },
  upTooMany: "{name}: troppi file (massimo {max})",
  upTooLarge: "{name}: troppo grande (massimo 10 MB)",
  upUploading: "Caricamento di {name}…",
  upFailed: "{name}: caricamento non riuscito, riprova",
  upRemove: "Rimuovi",
  mailReceivedTitle: "Abbiamo ricevuto il tuo reclamo {number}",
  mailReceivedBody: "Abbiamo ricevuto il tuo reclamo per l'ordine {order}. Lo esamineremo e ti scriveremo quando ci saranno novità.",
  mailViewClaim: "Vedi il tuo reclamo",
  mailReply: "Rispondi al negozio",
  mailUpdateTitle: "Reclamo {number}: {status}",
  mailSubject: "{title} (ordine {order})",
  mailLead: {
    OPEN: "Il tuo reclamo {number} per l'ordine {order} è in revisione.",
    NEEDS_INFO: "Ci servono altre informazioni per esaminare il tuo reclamo {number} per l'ordine {order}. Rispondi usando il link qui sotto.",
    APPROVED: "Buone notizie: il tuo reclamo {number} per l'ordine {order} è stato approvato.",
    REJECTED: "Abbiamo esaminato il tuo reclamo {number} per l'ordine {order} e non abbiamo potuto approvarlo.",
  },
  mailApprovedWith: "Buone notizie: il tuo reclamo {number} per l'ordine {order} è stato approvato ({resolution}).",
  mailResolvedTitle: "Reclamo {number}: risolto",
  mailRefunded: "Abbiamo rimborsato {amount} sul tuo metodo di pagamento originale. Potrebbero volerci alcuni giorni lavorativi.",
  mailReplacement: "Ti inviamo una sostituzione gratuita: ordine {replacement}. Riceverai le solite email di spedizione quando sarà in viaggio.",
  mailStoreCredit: "Abbiamo aggiunto {amount} di credito del negozio al tuo account. Si applica al pagamento quando hai effettuato l'accesso.",
};

const nl: Dict = {
  pageTitle: "Claims voor verzendbescherming",
  unavailable: "Bij deze winkel kun je geen claims online indienen. Neem contact op met de winkel.",
  lookupTitle: "Claim voor verzendbescherming indienen",
  lookupIntro: "Is je pakket kwijtgeraakt, gestolen of beschadigd aangekomen? Meld het hier. Zoek eerst je bestelling op.",
  orderNumber: "Bestelnummer",
  orderEmail: "E-mailadres van de bestelling",
  signedInOptional: "(optioneel — je bent ingelogd)",
  findOrder: "Mijn bestelling zoeken",
  alreadyFiled: "Al een claim ingediend? Bekijk de status via de link in je bevestigingsmail.",
  orderHeading: "Bestelling {order}",
  viewOpenClaim: "Openstaande claim bekijken",
  lookupAnother: "Andere bestelling zoeken",
  claimFor: "Claim voor bestelling {order}",
  whatHappened: "Wat is er gebeurd?",
  types: { LOST: "Kwijtgeraakt onderweg", STOLEN: "Gestolen na bezorging", DAMAGED: "Beschadigd aangekomen" },
  typeHelp: {
    LOST: "Het pakket is nooit aangekomen en staat niet als bezorgd, of de track-and-trace wordt niet meer bijgewerkt.",
    STOLEN: "Het pakket staat als bezorgd, maar je hebt het niet ontvangen.",
    DAMAGED: "Het pakket is aangekomen, maar artikelen waren kapot of beschadigd. Voeg foto's toe.",
  },
  whichItems: "Om welke artikelen gaat het?",
  each: "{price} per stuk",
  quantity: "Aantal",
  tellUs: "Vertel wat er is gebeurd",
  uploadLabel: "Foto's of documenten",
  uploadRequiredDamage: "verplicht bij schade",
  uploadRequiredAll: "een foto is verplicht bij schade, een document (zoals een aangifte bij de politie) bij een kwijtgeraakt of gestolen pakket",
  uploadFormats: "JPG, PNG, HEIC of PDF, maximaal 10 MB per bestand",
  updatesTo: "We sturen updates naar {email}.",
  confirmTrue: "De informatie die ik heb gegeven is juist en volledig.",
  submit: "Claim indienen",
  claimNumber: "Claim {number}",
  claimMeta: "Bestelling {order} · {type} · ingediend op {date}",
  statuses: { OPEN: "In behandeling", NEEDS_INFO: "Meer informatie nodig", APPROVED: "Goedgekeurd", REJECTED: "Niet goedgekeurd" },
  resolutions: { REFUND: "Terugbetaling", REPLACEMENT: "Vervanging", STORE_CREDIT: "Tegoed", OTHER: "Anders" },
  totalClaimed: "Totaal geclaimd",
  history: "Geschiedenis",
  evFiled: "Claim ingediend",
  evStaffFiled: "Claim aangemaakt door de winkel",
  evResolved: "Afgehandeld",
  evStatus: "Status: {status}",
  evYouFiles: "Je hebt bestanden toegevoegd",
  evStoreFiles: "De winkel heeft bestanden toegevoegd",
  evYouWrote: "Je schreef",
  evStoreWrote: "De winkel schreef",
  replyNeedsInfo: "Gevraagde informatie sturen",
  replyMessage: "Bericht voor de winkel",
  addFiles: "Foto's of documenten toevoegen",
  send: "Versturen",
  closed: "Deze claim is gesloten. Heb je vragen? Beantwoord de e-mail die je kreeg of neem contact op met de winkel.",
  filedOk: "Bedankt — je claim is ingediend. We hebben je een bevestiging gestuurd met een link naar deze pagina.",
  sentOk: "Verstuurd — de winkel neemt contact met je op.",
  errEnterBoth: "Vul je bestelnummer en e-mailadres in.",
  errLookupDown: "We kunnen nu geen bestellingen opzoeken. Probeer het later opnieuw of neem contact op met de winkel.",
  errNotFound: "We hebben geen bestelling gevonden met dit nummer en e-mailadres. Controleer beide en probeer het opnieuw.",
  errNoEmail: "Deze bestelling heeft geen e-mailadres, dus we kunnen geen updates sturen. Neem contact op met de winkel.",
  errExpired: "Deze pagina is verlopen. Zoek je bestelling opnieuw op.",
  errCantLoad: "We konden deze bestelling niet laden. Neem contact op met de winkel.",
  errChooseType: "Kies wat er met je pakket is gebeurd.",
  errChooseItem: "Kies minstens één artikel.",
  errDescribe: "Beschrijf wat er is gebeurd (minstens één zin).",
  errConfirm: "Bevestig dat de informatie klopt.",
  errPhoto: "Voeg minstens één foto van de schade toe.",
  errDocument: "Voeg een document toe, zoals een aangifte bij de politie of een antwoord van de vervoerder.",
  errBadLink: "Deze link is niet meer geldig. Gebruik de link uit je meest recente e-mail of neem contact op met de winkel.",
  errClosed: "Deze claim is gesloten. Neem contact op met de winkel.",
  errEmpty: "Schrijf een bericht of voeg een bestand toe.",
  errTooMany: "Te veel pogingen. Wacht 15 minuten en probeer het dan opnieuw.",
  refusal: {
    CANCELLED: "Deze bestelling is geannuleerd en kan daarom niet worden geclaimd.",
    NO_PROTECTION: "Deze bestelling had geen verzendbescherming en kan hier daarom niet worden geclaimd.",
    OPEN_CLAIM: "Er staat al een claim open voor deze bestelling.",
    ALREADY_CLAIMED: "Deze bestelling is al geclaimd. Neem contact op met de winkel.",
    NOT_SHIPPED: "Deze bestelling is nog niet verzonden. Je kunt een claim indienen zodra hij onderweg is.",
    WINDOW_SHIPPED: "Claims moeten binnen {days} dagen na verzending worden ingediend. Neem contact op met de winkel.",
    WINDOW_DELIVERED: "Claims moeten binnen {days} dagen na bezorging worden ingediend. Neem contact op met de winkel.",
    LOST_TOO_EARLY: "Een pakket kan {days} dagen na verzending als kwijt worden gemeld, vanaf {date}. Het is misschien nog onderweg.",
    OVER_ORDER_LIMIT: "Deze claim is hoger dan wat online per bestelling kan worden geclaimd. Neem contact op met de winkel.",
    OVER_CUSTOMER_LIMIT: "Deze claim is hoger dan wat online kan worden geclaimd. Neem contact op met de winkel.",
  },
  upTooMany: "{name}: te veel bestanden (maximaal {max})",
  upTooLarge: "{name}: te groot (maximaal 10 MB)",
  upUploading: "{name} uploaden…",
  upFailed: "{name}: uploaden mislukt — probeer het opnieuw",
  upRemove: "Verwijderen",
  mailReceivedTitle: "We hebben je claim {number} ontvangen",
  mailReceivedBody: "We hebben je claim voor bestelling {order} ontvangen. We bekijken hem en mailen je zodra er nieuws is.",
  mailViewClaim: "Je claim bekijken",
  mailReply: "De winkel antwoorden",
  mailUpdateTitle: "Claim {number}: {status}",
  mailSubject: "{title} (bestelling {order})",
  mailLead: {
    OPEN: "Je claim {number} voor bestelling {order} wordt bekeken.",
    NEEDS_INFO: "We hebben wat meer informatie nodig om je claim {number} voor bestelling {order} te beoordelen. Antwoord via de link hieronder.",
    APPROVED: "Goed nieuws: je claim {number} voor bestelling {order} is goedgekeurd.",
    REJECTED: "We hebben je claim {number} voor bestelling {order} bekeken en kunnen hem helaas niet goedkeuren.",
  },
  mailApprovedWith: "Goed nieuws: je claim {number} voor bestelling {order} is goedgekeurd ({resolution}).",
  mailResolvedTitle: "Claim {number}: afgehandeld",
  mailRefunded: "We hebben {amount} terugbetaald op je oorspronkelijke betaalmethode. Het kan een paar werkdagen duren voordat je het ziet.",
  mailReplacement: "We sturen je kosteloos een vervanging: bestelling {replacement}. Je krijgt de gebruikelijke verzendmails zodra hij onderweg is.",
  mailStoreCredit: "We hebben {amount} tegoed aan je account toegevoegd. Het wordt verrekend bij het afrekenen als je bent ingelogd.",
};

const hi: Dict = {
  pageTitle: "शिपिंग सुरक्षा दावे",
  unavailable: "इस स्टोर के लिए ऑनलाइन दावा दर्ज नहीं किया जा सकता। कृपया स्टोर से संपर्क करें।",
  lookupTitle: "शिपिंग सुरक्षा दावा दर्ज करें",
  lookupIntro: "अगर आपका पैकेज खो गया, चोरी हो गया या क्षतिग्रस्त पहुँचा, तो यहाँ बताएँ। पहले अपना ऑर्डर खोजें।",
  orderNumber: "ऑर्डर नंबर",
  orderEmail: "ऑर्डर में इस्तेमाल किया गया ईमेल",
  signedInOptional: "(वैकल्पिक — आप साइन इन हैं)",
  findOrder: "मेरा ऑर्डर खोजें",
  alreadyFiled: "पहले ही दावा दर्ज कर चुके हैं? उसकी स्थिति देखने के लिए पुष्टि ईमेल में दिए लिंक का उपयोग करें।",
  orderHeading: "ऑर्डर {order}",
  viewOpenClaim: "खुला दावा देखें",
  lookupAnother: "कोई दूसरा ऑर्डर खोजें",
  claimFor: "ऑर्डर {order} के लिए दावा",
  whatHappened: "क्या हुआ?",
  types: { LOST: "रास्ते में खो गया", STOLEN: "डिलीवरी के बाद चोरी हो गया", DAMAGED: "क्षतिग्रस्त पहुँचा" },
  typeHelp: {
    LOST: "पैकेज कभी नहीं पहुँचा और डिलीवर नहीं दिखाया गया है, या ट्रैकिंग अपडेट होना बंद हो गई।",
    STOLEN: "पैकेज डिलीवर दिखाया गया, लेकिन आपको नहीं मिला।",
    DAMAGED: "पैकेज पहुँचा, लेकिन सामान टूटा या क्षतिग्रस्त था। कृपया फ़ोटो जोड़ें।",
  },
  whichItems: "कौन-से आइटम प्रभावित हैं?",
  each: "{price} प्रति आइटम",
  quantity: "मात्रा",
  tellUs: "बताएँ कि क्या हुआ",
  uploadLabel: "फ़ोटो या दस्तावेज़",
  uploadRequiredDamage: "क्षति के दावों के लिए ज़रूरी",
  uploadRequiredAll: "क्षति के दावों के लिए फ़ोटो, और खोए या चोरी हुए पैकेज के लिए एक दस्तावेज़ (जैसे पुलिस रिपोर्ट) ज़रूरी है",
  uploadFormats: "JPG, PNG, HEIC या PDF, हर फ़ाइल अधिकतम 10 MB",
  updatesTo: "हम अपडेट {email} पर भेजेंगे।",
  confirmTrue: "मेरी दी गई जानकारी सही और पूरी है।",
  submit: "दावा भेजें",
  claimNumber: "दावा {number}",
  claimMeta: "ऑर्डर {order} · {type} · {date} को दर्ज",
  statuses: { OPEN: "समीक्षा में", NEEDS_INFO: "और जानकारी चाहिए", APPROVED: "स्वीकृत", REJECTED: "स्वीकृत नहीं" },
  resolutions: { REFUND: "रिफ़ंड", REPLACEMENT: "बदले में नया सामान", STORE_CREDIT: "स्टोर क्रेडिट", OTHER: "अन्य" },
  totalClaimed: "कुल दावा राशि",
  history: "इतिहास",
  evFiled: "दावा दर्ज किया गया",
  evStaffFiled: "दावा स्टोर ने बनाया",
  evResolved: "निपटाया गया",
  evStatus: "स्थिति: {status}",
  evYouFiles: "आपने फ़ाइलें जोड़ीं",
  evStoreFiles: "स्टोर ने फ़ाइलें जोड़ीं",
  evYouWrote: "आपने लिखा",
  evStoreWrote: "स्टोर ने लिखा",
  replyNeedsInfo: "माँगी गई जानकारी भेजें",
  replyMessage: "स्टोर के लिए संदेश जोड़ें",
  addFiles: "फ़ोटो या दस्तावेज़ जोड़ें",
  send: "भेजें",
  closed: "यह दावा बंद हो चुका है। कोई सवाल हो तो मिले ईमेल का जवाब दें या स्टोर से संपर्क करें।",
  filedOk: "धन्यवाद — आपका दावा दर्ज हो गया है। हमने आपको इस पेज के लिंक के साथ पुष्टि ईमेल भेजा है।",
  sentOk: "भेज दिया गया — स्टोर आपसे संपर्क करेगा।",
  errEnterBoth: "अपना ऑर्डर नंबर और ईमेल दर्ज करें।",
  errLookupDown: "अभी ऑर्डर नहीं खोजे जा सकते। कृपया बाद में फिर कोशिश करें या स्टोर से संपर्क करें।",
  errNotFound: "इस नंबर और ईमेल वाला कोई ऑर्डर नहीं मिला। दोनों जाँचें और फिर कोशिश करें।",
  errNoEmail: "इस ऑर्डर में कोई ईमेल पता नहीं है, इसलिए हम अपडेट नहीं भेज सकते। कृपया स्टोर से संपर्क करें।",
  errExpired: "इस पेज की समय-सीमा खत्म हो गई। कृपया अपना ऑर्डर फिर से खोजें।",
  errCantLoad: "यह ऑर्डर लोड नहीं हो सका। कृपया स्टोर से संपर्क करें।",
  errChooseType: "चुनें कि आपके पैकेज के साथ क्या हुआ।",
  errChooseItem: "कम से कम एक प्रभावित आइटम चुनें।",
  errDescribe: "कृपया बताएँ कि क्या हुआ (कम से कम एक वाक्य)।",
  errConfirm: "कृपया पुष्टि करें कि जानकारी सही है।",
  errPhoto: "कृपया क्षति की कम से कम एक फ़ोटो जोड़ें।",
  errDocument: "कृपया एक सहायक दस्तावेज़ जोड़ें, जैसे पुलिस रिपोर्ट या कूरियर कंपनी का जवाब।",
  errBadLink: "यह लिंक अब मान्य नहीं है। अपने सबसे नए ईमेल का लिंक इस्तेमाल करें या स्टोर से संपर्क करें।",
  errClosed: "यह दावा बंद हो चुका है। कृपया स्टोर से संपर्क करें।",
  errEmpty: "संदेश लिखें या फ़ाइल जोड़ें।",
  errTooMany: "बहुत ज़्यादा कोशिशें। कृपया 15 मिनट बाद फिर कोशिश करें।",
  refusal: {
    CANCELLED: "यह ऑर्डर रद्द कर दिया गया था, इसलिए इस पर दावा नहीं किया जा सकता।",
    NO_PROTECTION: "इस ऑर्डर में शिपिंग सुरक्षा शामिल नहीं थी, इसलिए यहाँ दावा नहीं किया जा सकता।",
    OPEN_CLAIM: "इस ऑर्डर के लिए पहले से एक दावा खुला है।",
    ALREADY_CLAIMED: "इस ऑर्डर पर पहले ही दावा किया जा चुका है। कृपया स्टोर से संपर्क करें।",
    NOT_SHIPPED: "यह ऑर्डर अभी भेजा नहीं गया है। रवाना होने के बाद आप दावा कर सकते हैं।",
    WINDOW_SHIPPED: "दावे शिपिंग के {days} दिनों के भीतर दर्ज करने होते हैं। कृपया स्टोर से संपर्क करें।",
    WINDOW_DELIVERED: "दावे डिलीवरी के {days} दिनों के भीतर दर्ज करने होते हैं। कृपया स्टोर से संपर्क करें।",
    LOST_TOO_EARLY: "पैकेज को शिपिंग के {days} दिन बाद, {date} से, खोया हुआ बताया जा सकता है। हो सकता है वह अभी रास्ते में हो।",
    OVER_ORDER_LIMIT: "यह दावा एक ऑर्डर के लिए ऑनलाइन दावे की सीमा से ज़्यादा है। कृपया स्टोर से संपर्क करें।",
    OVER_CUSTOMER_LIMIT: "यह दावा ऑनलाइन दावे की सीमा से ज़्यादा है। कृपया स्टोर से संपर्क करें।",
  },
  upTooMany: "{name}: बहुत ज़्यादा फ़ाइलें (अधिकतम {max})",
  upTooLarge: "{name}: बहुत बड़ी (अधिकतम 10 MB)",
  upUploading: "{name} अपलोड हो रही है…",
  upFailed: "{name}: अपलोड नहीं हुई — फिर कोशिश करें",
  upRemove: "हटाएँ",
  mailReceivedTitle: "हमें आपका दावा {number} मिल गया है",
  mailReceivedBody: "हमें ऑर्डर {order} के लिए आपका दावा मिल गया है। हम इसकी समीक्षा करेंगे और कोई अपडेट होने पर आपको ईमेल करेंगे।",
  mailViewClaim: "अपना दावा देखें",
  mailReply: "स्टोर को जवाब दें",
  mailUpdateTitle: "दावा {number}: {status}",
  mailSubject: "{title} (ऑर्डर {order})",
  mailLead: {
    OPEN: "ऑर्डर {order} के लिए आपके दावे {number} की समीक्षा हो रही है।",
    NEEDS_INFO: "ऑर्डर {order} के लिए आपके दावे {number} की समीक्षा के लिए हमें थोड़ी और जानकारी चाहिए। कृपया नीचे दिए लिंक से जवाब दें।",
    APPROVED: "अच्छी खबर: ऑर्डर {order} के लिए आपका दावा {number} स्वीकृत हो गया है।",
    REJECTED: "हमने ऑर्डर {order} के लिए आपके दावे {number} की समीक्षा की, लेकिन इसे स्वीकृत नहीं कर सके।",
  },
  mailApprovedWith: "अच्छी खबर: ऑर्डर {order} के लिए आपका दावा {number} स्वीकृत हो गया है ({resolution})।",
  mailResolvedTitle: "दावा {number}: निपटाया गया",
  mailRefunded: "हमने {amount} आपके मूल भुगतान तरीके पर रिफ़ंड कर दिए हैं। इसे दिखने में कुछ कार्यदिवस लग सकते हैं।",
  mailReplacement: "हम आपको बिना किसी शुल्क के बदले में सामान भेज रहे हैं: ऑर्डर {replacement}। रवाना होने पर आपको सामान्य शिपिंग ईमेल मिलेंगे।",
  mailStoreCredit: "हमने आपके खाते में {amount} का स्टोर क्रेडिट जोड़ दिया है। साइन इन होने पर यह चेकआउट पर लागू होता है।",
};

export const DICTS: Record<Locale, Dict> = { en, de, fr, es, it, nl, hi };

/** Fill {placeholders}. Unknown ones are left as they are. */
export function fill(template: string, vars: Record<string, string | number> = {}) {
  return template.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

export const refusalText = (r: Refusal, locale: Locale = "en") => fill(DICTS[locale].refusal[r.code], r.vars);

/** Dates and money in the customer's language. */
export const formatDate = (iso: string | Date, locale: Locale) =>
  new Date(iso).toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" });

export function formatMoney(amount: number, currency: string, locale: Locale) {
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}
