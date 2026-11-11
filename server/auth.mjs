import {
  createHmac,
  timingSafeEqual,
  randomBytes,
  createHash,
} from "node:crypto";
import { demand } from "./domain.mjs";
export const digest = (s) => createHash("sha256").update(s).digest("hex");
export function validateTelegram(raw, token, now = Date.now(), maxAge = 300) {
  demand(
    typeof raw === "string" && raw.length <= 16384 && token,
    "Нет данных Telegram",
    401,
  );
  const params = new URLSearchParams(raw);
  demand(
    [...params.keys()].length === new Set(params.keys()).size,
    "Повтор полей Telegram",
    401,
  );
  const hash = params.get("hash");
  demand(
    /^[a-f0-9]{64}$/i.test(hash || ""),
    "Некорректная подпись Telegram",
    401,
  );
  params.delete("hash");
  const data = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const expected = createHmac("sha256", secret).update(data).digest();
  demand(
    timingSafeEqual(expected, Buffer.from(hash, "hex")),
    "Некорректная подпись Telegram",
    401,
  );
  const stamp = Number(params.get("auth_date"));
  demand(
    Number.isInteger(stamp) &&
      stamp <= now / 1000 + 30 &&
      now / 1000 - stamp <= maxAge,
    "Данные Telegram устарели. Откройте приложение заново.",
    401,
  );
  let user;
  try {
    user = JSON.parse(params.get("user"));
  } catch {}
  demand(
    Number.isSafeInteger(user?.id) && user.id > 0,
    "Нет Telegram-пользователя",
    401,
  );
  return String(user.id);
}
export function newSession(db, userId, now = Date.now()) {
  const token = randomBytes(32).toString("base64url");
  db.prepare("DELETE FROM sessions WHERE expires<?").run(now);
  db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
    digest(token),
    userId,
    now + 8 * 3600000,
  );
  return token;
}
export function sessionUser(req, store) {
  const authorization = req.headers.authorization;
  let token;
  if (authorization !== undefined) {
    // An invalid explicit credential must not fall back to a different cookie.
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization);
    if (!match) return null;
    token = match[1];
  } else {
    token = req.headers.cookie
      ?.split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("vpr_session="))
      ?.slice(12);
  }
  if (!token) return null;
  const session = store.db
    .prepare("SELECT * FROM sessions WHERE token_hash=? AND expires>?")
    .get(digest(token), Date.now());
  if (!session) return null;
  const user = store.user(session.user_id);
  return user?.active ? user : null;
}
