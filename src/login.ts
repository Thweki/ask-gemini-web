import { pause } from './browser.js';
import { DraftError } from './errors.js';
import type { Auth, Gemini } from './gemini.js';

// Keep polling through account login/challenge pages while the user signs in.
export async function waitForLogin(gemini: Pick<Gemini, 'auth' | 'requireLogin'>, timeoutMs: number,
  onStatus: (auth: Auth) => void = () => {}, wait = pause) {
  const deadline = Date.now() + timeoutMs;
  let previous = '';
  while (Date.now() < deadline) {
    const auth = await gemini.auth();
    if (auth.status === 'blocked_sorry') await gemini.requireLogin();
    if (auth.status === 'logged_in') return auth;
    if (auth.status !== previous) { onStatus(auth); previous = auth.status; }
    await wait(1000);
  }
  throw new DraftError('LOGIN_TIMEOUT', '等待登录超时，Chrome 已保留。完成登录后运行 auth status。', 3);
}
