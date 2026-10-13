// Expose known error categories, not arbitrary provider output that may contain
// prompts, URLs or credentials. Keep the diagnostic durable across restarts.
const reasons = {
  serverOverloaded: 'Vybraný model je momentálně přetížený. Zkus úkol později nebo zvol jiný model.',
  usageLimitExceeded: 'Byl vyčerpán limit používání modelu.',
  rateLimitExceeded: 'Byl překročen limit četnosti požadavků.',
  contextWindowExceeded: 'Konverzace překročila kapacitu kontextu modelu.',
  sessionBudgetExceeded: 'Byl vyčerpán rozpočet této relace.',
  unauthorized: 'Codex nemá platné přihlášení nebo oprávnění k modelu.',
  flexUnavailable: 'Požadovaný režim zpracování modelu není dostupný.',
  internalServerError: 'Služba modelu ohlásila interní chybu.',
  badRequest: 'Služba odmítla parametry požadavku.',
  sandboxError: 'Selhalo spuštění v sandboxu.',
  tooManyDenials: 'Úkol skončil po opakovaném odmítnutí schválení.',
  cyberPolicy: 'Požadavek byl zablokován bezpečnostními pravidly služby.',
  misalignmentPolicyViolation: 'Požadavek byl zablokován pravidly služby.',
  httpConnectionFailed: 'Nepodařilo se připojit ke službě modelu.',
  responseStreamConnectionFailed: 'Nepodařilo se připojit k odpovědi modelu.',
  responseStreamDisconnected: 'Spojení s modelem se během odpovědi přerušilo.',
  responseTooManyFailedAttempts: 'Opakované pokusy služby o získání odpovědi selhaly.',
  timeout: 'Vypršel čas čekání na odpověď; výsledek operace může být nejistý.',
  connection: 'Spojení bylo přerušeno; výsledek operace může být nejistý.',
  discordAccess: 'Bot nemá potřebný přístup k cíli v Discordu.',
  discordDeleted: 'Cílový kanál nebo vlákno již neexistuje.',
  restart: 'Bot se restartoval během rozpracovaného úkolu. Nejdříve ověř jeho stav.',
};

export function runFailure(error, phase, at = Date.now(), turnId = null) {
  const info = error?.codexErrorInfo ?? error?.codex_error_info;
  let code = typeof info === 'string' ? info : Object.keys(info || {})[0];
  code = code?.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
  if (!reasons[code]) {
    code = phase === 'restart' ? 'restart' : [50001, 50013].includes(error?.code) ? 'discordAccess' :
      error?.code === 10003 ? 'discordDeleted' : /timed? ?out|timeout/i.test(error?.message || '') ? 'timeout' :
      /connection|disconnect|socket/i.test(error?.message || '') ? 'connection' : 'unknown';
  }
  return { code, message: reasons[code] || 'Operace selhala bez rozpoznané kategorie chyby. Je nutná kontrola diagnostiky.', phase, at, turnId };
}

export function failureText(failure) {
  return failure ? `Poslední chyba: ${failure.message} [${failure.code}]` : '';
}
