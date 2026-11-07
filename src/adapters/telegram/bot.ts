interface TelegramAccountIdentity {
  isBot?: boolean;
  username?: string | null;
}

/** Use Telegram's explicit bot flag first, then the documented username suffix as fallback. */
export function isTelegramBotAccount(account: TelegramAccountIdentity): boolean {
  if (account.isBot === true) return true;
  const username = account.username?.trim();
  return Boolean(username && /bot$/i.test(username));
}
