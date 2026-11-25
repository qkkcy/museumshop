// 오디움 뮤지엄샵 - 발주 필요 푸시 알림 Worker (Cloudflare Workers, 무료 플랜)
//
// 하는 일 (5분마다):
//  1) Firebase Realtime Database 에서 앱이 적어둔 "발주 필요 목록"(museumshop_push/low)과
//     알림 받을 기기 목록(museumshop_push/tokens)을 읽는다.
//  2) 이전에 알림을 보내지 않은 새 품목이 있으면 FCM 푸시를 보낸다.
//  3) 알림 보낸 품목은 museumshop_push/alerted 에 기록해서 중복 알림을 막는다.
//     (재고가 회복돼서 목록에서 사라지면 기록에서도 빠지고, 다시 떨어지면 또 알림)
//
// 필요한 설정 (Cloudflare 대시보드):
//  - 비밀(Secret)  SERVICE_ACCOUNT : Firebase 서비스 계정 JSON 전체
//  - 변수(Variable) DB_URL          : Realtime Database 주소
//  - 변수(Variable) APP_URL         : 앱 주소 (알림 탭하면 열릴 주소)
//  - (선택) 비밀 ADMIN_KEY          : 설정하면 /?key=... 로 테스트/상태확인 가능

const DB_PATH = 'museumshop_push';

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(run(env));
  },

  // 선택 기능: ADMIN_KEY 를 설정했을 때만 동작. 설정 안 하면 항상 404.
  async fetch(request, env) {
    const u = new URL(request.url);
    if (!env.ADMIN_KEY || u.searchParams.get('key') !== env.ADMIN_KEY) {
      return new Response('not found', { status: 404 });
    }
    const sa = JSON.parse(env.SERVICE_ACCOUNT);
    const at = await getAccessToken(sa);
    if (u.searchParams.get('test')) {
      const tokens = Object.keys((await dbGet(env, at, `${DB_PATH}/tokens`)) || {});
      const res = await sendAll(env, sa, at, tokens, {
        title: '🔔 테스트 알림',
        body: '푸시 알림이 정상적으로 연결됐어요.',
      });
      return json({ test: true, tokens: tokens.length, ...res });
    }
    if (u.searchParams.get('reset')) {
      await dbPut(env, at, `${DB_PATH}/alerted`, null);
      return json({ reset: true });
    }
    const low = toArr((await dbGet(env, at, `${DB_PATH}/low`))?.items);
    const tokens = Object.keys((await dbGet(env, at, `${DB_PATH}/tokens`)) || {});
    const alerted = toArr(await dbGet(env, at, `${DB_PATH}/alerted`));
    return json({ low, tokens: tokens.length, alerted });
  },
};

async function run(env) {
  const sa = JSON.parse(env.SERVICE_ACCOUNT);
  const at = await getAccessToken(sa);

  const lowNode = await dbGet(env, at, `${DB_PATH}/low`);
  if (!lowNode) return { skipped: 'no-low-node' }; // 앱이 아직 한 번도 기록하지 않음
  const low = toArr(lowNode.items);
  const lowIds = low.map(i => String(i.id));
  const alerted = toArr(await dbGet(env, at, `${DB_PATH}/alerted`)).map(String);

  const fresh = low.filter(i => !alerted.includes(String(i.id)));

  // 새로 알릴 품목이 없으면: 회복된 품목만 기록에서 정리
  if (fresh.length === 0) {
    if (!sameSet(alerted, lowIds)) await dbPut(env, at, `${DB_PATH}/alerted`, lowIds);
    return { sent: 0, cleaned: true };
  }

  const tokens = Object.keys((await dbGet(env, at, `${DB_PATH}/tokens`)) || {});
  if (tokens.length === 0) return { skipped: 'no-tokens' }; // 기록하지 않음 → 기기 등록 후 알림 가능

  const shown = fresh.slice(0, 4).map(i => `${i.name}(${i.total}개)`).join(', ');
  const more = fresh.length > 4 ? ` 외 ${fresh.length - 4}건` : '';
  const res = await sendAll(env, sa, at, tokens, {
    title: `🚨 발주 필요 ${fresh.length}건`,
    body: `${shown}${more} 발주필요`,
  });

  // 한 기기라도 성공했을 때만 "알림 보냄"으로 기록 (전부 실패하면 다음 실행에서 재시도)
  if (res.ok > 0) await dbPut(env, at, `${DB_PATH}/alerted`, lowIds);
  return { fresh: fresh.length, ...res };
}

// ── FCM 전송 ──────────────────────────────────────────────
async function sendAll(env, sa, at, tokens, { title, body }) {
  let ok = 0, failed = 0, removed = 0;
  const url = env.APP_URL || 'https://qkkcy.github.io/museumshop/';
  for (const token of tokens) {
    const r = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${at}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          token,
          data: { title, body, url, tag: 'reorder' },
          webpush: { headers: { Urgency: 'high', TTL: '86400' } },
        },
      }),
    });
    if (r.ok) { ok++; continue; }
    const text = await r.text();
    if (r.status === 404 || text.includes('UNREGISTERED')) {
      // 만료/삭제된 기기 토큰 정리
      await dbPut(env, at, `${DB_PATH}/tokens/${token}`, null);
      removed++;
    } else {
      failed++;
      console.log('FCM 실패', r.status, text.slice(0, 200));
    }
  }
  return { ok, failed, removed };
}

// ── Realtime Database REST ────────────────────────────────
async function dbGet(env, at, path) {
  const r = await fetch(`${env.DB_URL}/${path}.json?access_token=${at}`);
  if (!r.ok) throw new Error(`DB GET ${path} ${r.status}`);
  return r.json();
}
async function dbPut(env, at, path, value) {
  const r = await fetch(`${env.DB_URL}/${path}.json?access_token=${at}`, {
    method: value === null ? 'DELETE' : 'PUT',
    body: value === null ? undefined : JSON.stringify(value),
  });
  if (!r.ok) throw new Error(`DB WRITE ${path} ${r.status}`);
}

// ── 구글 OAuth (서비스 계정 JWT) ───────────────────────────
async function getAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: [
      'https://www.googleapis.com/auth/firebase.database',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/firebase.messaging',
    ].join(' '),
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const data = `${header}.${claim}`;
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToBuf(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(data));
  const jwt = `${data}.${b64url(sig)}`;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  if (!r.ok) throw new Error(`OAuth ${r.status} ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).access_token;
}

// ── 유틸 ──────────────────────────────────────────────────
function toArr(v) { if (!v) return []; return Array.isArray(v) ? v.filter(x => x != null) : Object.values(v); }
function sameSet(a, b) { return a.length === b.length && a.every(x => b.includes(x)); }
function json(o) { return new Response(JSON.stringify(o, null, 2), { headers: { 'Content-Type': 'application/json; charset=utf-8' } }); }
function b64url(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function pemToBuf(pem) {
  const b = atob(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''));
  const buf = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) buf[i] = b.charCodeAt(i);
  return buf.buffer;
}
