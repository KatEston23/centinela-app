// Avisos propios de la app (Web Push estándar: iPhone con la app en la pantalla de inicio, Android, escritorio).
// Sin dependencias: firma VAPID (ES256) y cifrado aes128gcm (RFC 8291) con node:crypto.
// El contenido va cifrado de extremo a extremo: el servicio de avisos (Apple, Google…) no puede leerlo.
import { createECDH, createHmac, createCipheriv, createPrivateKey, randomBytes, sign, generateKeyPairSync } from "node:crypto";

const b64u = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s) => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();

/** Genera un par de claves VAPID: { jwk (privada, para el secreto), publicKey (base64url, para la app) }. */
export function generateVapid() {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = privateKey.export({ format: "jwk" });
  return { jwk, publicKey: b64u(Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)])) };
}
export const vapidPublic = (jwk) => b64u(Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)]));

function vapidHeader(endpoint, jwk, subject) {
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const body = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }));
  const key = createPrivateKey({ key: jwk, format: "jwk" });
  const sig = sign("sha256", Buffer.from(`${head}.${body}`), { key, dsaEncoding: "ieee-p1363" });
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${vapidPublic(jwk)}`;
}

/** Cifra el contenido para una suscripción (RFC 8291, aes128gcm, un solo registro). */
export function encryptPayload(sub, payload, { salt = randomBytes(16) } = {}) {
  const uaPublic = unb64u(sub.keys.p256dh), auth = unb64u(sub.keys.auth);
  const ecdh = createECDH("prime256v1"); ecdh.generateKeys(); // clave efímera por aviso
  const asPublic = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(uaPublic);
  const prkKey = hmac(auth, secret);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);
  const c = createCipheriv("aes-128-gcm", cek, nonce);
  const ct = Buffer.concat([c.update(Buffer.concat([Buffer.from(payload, "utf8"), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, ct]);
}

/**
 * Envía un aviso a una suscripción. Devuelve { ok, gone, status }.
 * gone = la suscripción ya no existe (app borrada o avisos desactivados): hay que olvidarla.
 */
export async function sendPush(sub, message, jwk, { subject = "https://kateston23.github.io/centinela-app/", ttl = 86400, urgency = "normal", topic } = {}) {
  const body = encryptPayload(sub, JSON.stringify(message));
  const headers = { TTL: String(ttl), Urgency: urgency, "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", Authorization: vapidHeader(sub.endpoint, jwk, subject) };
  if (topic) headers.Topic = String(topic).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
  const r = await fetch(sub.endpoint, { method: "POST", headers, body });
  return { ok: r.status >= 200 && r.status < 300, gone: r.status === 404 || r.status === 410, status: r.status, text: r.ok ? "" : (await r.text().catch(() => "")).slice(0, 200) };
}
