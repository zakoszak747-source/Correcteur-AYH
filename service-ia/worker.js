// Service IA partagé (Cloudflare Worker) avec quotas par code d'accès.
// Utilise Google Gemini si GEMINI_API_KEY existe, sinon Claude (ANTHROPIC_API_KEY).
// Variables (type Secret) : GEMINI_API_KEY (ou ANTHROPIC_API_KEY), ACCESS_CODES.
//   ACCESS_CODES : codes séparés par des virgules. Pour limiter un code : code:nombre d'appels IA par mois.
//   Exemple : MonCodePerso,Prof-Marie-4821:300,Prof-Koffi-7733:150   (sans limite pour MonCodePerso)
// Pour appliquer les quotas : ajoute un stockage KV (Bindings > KV namespace) avec le nom de variable QUOTA.
// ABONNEMENTS : ADMIN_CODE (Secret) = ton code administrateur. Avec le stockage KV QUOTA, tu crées des codes d'abonnement
//   (nom, appels IA par mois, durée) depuis l'application : Menu > Réglages de l'IA > Gérer les abonnements.
// Facultatif : GEMINI_MODEL (par défaut gemini-3.5-flash-lite), GEMINI_THINKING (low, medium, high), MODEL (modèle Claude).
const clean = v => String(v || '').trim().replace(/^["']|["']$/g, '');
const month = () => new Date().toISOString().slice(0, 7);
const parse = env => (env.ACCESS_CODES || '').split(',').map(s => s.trim()).filter(Boolean).map(s => {
  const i = s.lastIndexOf(':');
  return i > 0 && /^\d+$/.test(s.slice(i + 1)) ? { code: s.slice(0, i), limit: parseInt(s.slice(i + 1)) } : { code: s, limit: 0 };
});
const usedOf = async (env, code) => env.QUOTA ? (parseInt(await env.QUOTA.get('u:' + code + ':' + month())) || 0) : 0;

const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const gen = () => { const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789', u = crypto.getRandomValues(new Uint8Array(8)); let s = ''; for (const x of u) s += A[x % A.length]; return 'AYH-' + s.slice(0, 4) + '-' + s.slice(4); };

// Retrouve l'abonné à partir du code : administrateur, code de la variable ACCESS_CODES, ou abonnement enregistré dans KV.
async function resolve(env, code) {
  if (!code) return { err: 'code refusé' };
  const adm = clean(env.ADMIN_CODE);
  if (adm && code === adm) return { ent: { code, limit: 0, exp: '', nom: 'Administrateur', admin: true } };
  const lg = parse(env).find(x => x.code === code);
  if (lg) return { ent: { code, limit: lg.limit, exp: '', nom: '' } };
  if (env.QUOTA) {
    const raw = await env.QUOTA.get('s:' + code);
    if (raw) {
      let r = {}; try { r = JSON.parse(raw); } catch (e) {}
      if (r.o) return { err: 'abonnement suspendu' };
      if (r.e && r.e < today()) return { err: 'abonnement expiré', exp: r.e };
      return { ent: { code, limit: r.l || 0, exp: r.e || '', nom: r.n || '' } };
    }
  }
  return { err: 'code refusé' };
}

async function admin(req, env, json) {
  if (req.method !== 'POST') return json({ error: 'POST requis' }, 405);
  if (!env.QUOTA) return json({ error: 'stockage KV QUOTA manquant' }, 500);
  let b = {}; try { b = await req.json(); } catch (e) {}
  const read = async code => { const raw = await env.QUOTA.get('s:' + code); if (!raw) return null; try { return JSON.parse(raw); } catch (e) { return null; } };
  const save = (code, r) => env.QUOTA.put('s:' + code, JSON.stringify(r));
  if (b.op === 'create') {
    let code = /^[A-Za-z0-9_-]{4,40}$/.test(b.code || '') ? b.code : '';
    if (!code) { for (let i = 0; i < 6; i++) { const c = gen(); if (!(await read(c))) { code = c; break; } } }
    if (!code) return json({ error: 'création impossible, réessaie' }, 500);
    const j = Math.min(Math.max(parseInt(b.j) || 30, 1), 3650), l = Math.max(parseInt(b.l) || 0, 0);
    const rec = { n: String(b.n || '').slice(0, 60), l, e: addDays(today(), j), c: today(), o: 0 };
    await save(code, rec);
    return json({ code, exp: rec.e, l }, 200);
  }
  if (b.op === 'list') {
    const items = []; let cursor;
    for (let p = 0; p < 5; p++) {
      const r = await env.QUOTA.list({ prefix: 's:', cursor });
      for (const k of r.keys) { const code = k.name.slice(2), rec = await read(code); if (rec) items.push({ code, ...rec, used: await usedOf(env, code) }); }
      if (r.list_complete) break; cursor = r.cursor;
    }
    return json({ items }, 200);
  }
  const code = String(b.code || ''), rec = await read(code);
  if (!rec) return json({ error: 'code introuvable' }, 404);
  if (b.op === 'renew') {
    const j = Math.min(Math.max(parseInt(b.j) || 30, 1), 3650), base = rec.e && rec.e > today() ? rec.e : today();
    rec.e = addDays(base, j); rec.o = 0; if (b.l != null && parseInt(b.l) >= 0) rec.l = parseInt(b.l);
    await save(code, rec); return json({ ok: 1, exp: rec.e }, 200);
  }
  if (b.op === 'off') { rec.o = b.o ? 1 : 0; await save(code, rec); return json({ ok: 1 }, 200); }
  if (b.op === 'del') { await env.QUOTA.delete('s:' + code); return json({ ok: 1 }, 200); }
  return json({ error: 'opération inconnue' }, 400);
}

async function gemini(b, key, env, json) {
  const parts = [];
  for (const m of b.messages) {
    const c = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : (m.content || []);
    for (const p of c) {
      if (p.type === 'text') parts.push({ text: p.text });
      else if ((p.type === 'image' || p.type === 'document') && p.source) parts.push({ inline_data: { mime_type: p.source.media_type || (p.type === 'document' ? 'application/pdf' : 'image/jpeg'), data: p.source.data } });
    }
  }
  const model = clean(env.GEMINI_MODEL) || 'gemini-3.5-flash-lite';
  const g3 = /gemini-3/i.test(model);
  const gc = g3 ? { maxOutputTokens: 16384 } : { maxOutputTokens: 8192, temperature: 0.2 };
  const lvl = clean(env.GEMINI_THINKING).toLowerCase();
  if (g3 && /^(low|medium|high)$/.test(lvl)) gc.thinkingConfig = { thinkingLevel: lvl };
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: gc })
  });
  let j = {};
  try { j = await r.json(); } catch (e) {}
  if (!r.ok) {
    const msg = (j.error && j.error.message) || '';
    const bad = /API key not valid|API_KEY_INVALID|PERMISSION_DENIED/i.test(JSON.stringify(j));
    return json({ error: { type: bad ? 'authentication_error' : 'api_error', message: msg } }, bad ? 401 : r.status);
  }
  const cand = (j.candidates || [])[0] || {};
  const text = ((cand.content && cand.content.parts) || [])
    .filter(p => !p.thought && typeof p.text === 'string').map(p => p.text).join('');
  if (!text) {
    const why = cand.finishReason || (j.promptFeedback && j.promptFeedback.blockReason) || 'inconnue';
    return json({ error: { type: 'api_error', message: 'Réponse vide (' + why + ')' } }, 502);
  }
  return json({ content: [{ type: 'text', text }] }, 200);
}

export default {
  async fetch(req, env) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'content-type,x-access-code',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
    };
    const json = (o, s) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, 'content-type': 'application/json' } });
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

    const code = (req.headers.get('x-access-code') || '').trim();
    const path = new URL(req.url).pathname.replace(/\/+$/, '');

    if (path === '/admin') {
      const adm = clean(env.ADMIN_CODE);
      if (!adm || code !== adm) return json({ error: 'code refusé' }, 401);
      return admin(req, env, json);
    }

    if (req.method === 'GET') {
      if (!code) return new Response('Service IA AYH : en ligne', { headers: cors });
      const r = await resolve(env, code);
      if (r.err) return json({ error: r.err, exp: r.exp }, r.err === 'code refusé' ? 401 : 402);
      return json({ used: await usedOf(env, code), limit: r.ent.limit, exp: r.ent.exp, nom: r.ent.nom, month: month() }, 200);
    }
    if (req.method !== 'POST') return new Response('Méthode non autorisée', { status: 405, headers: cors });
    const rs = await resolve(env, code);
    if (rs.err) return json({ error: rs.err, exp: rs.exp }, rs.err === 'code refusé' ? 401 : 402);
    const ent = rs.ent;

    let used = 0;
    if (ent.limit > 0) {
      if (!env.QUOTA) return json({ error: 'quota non disponible : ajoute le stockage KV nommé QUOTA au Worker' }, 500);
      used = await usedOf(env, code);
      if (used >= ent.limit) return json({ error: 'quota épuisé' }, 402);
    }

    let b;
    try { b = await req.json(); } catch (e) { return json({ error: 'requête invalide' }, 400); }
    if (!Array.isArray(b.messages)) return json({ error: 'requête invalide' }, 400);

    const gk = clean(env.GEMINI_API_KEY), ak = clean(env.ANTHROPIC_API_KEY);
    let resp;
    if (gk) resp = await gemini(b, gk, env, json);
    else if (!ak) return json({ error: 'clé absente : crée la variable GEMINI_API_KEY (ou ANTHROPIC_API_KEY) dans ce Worker' }, 500);
    else {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': ak, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: clean(env.MODEL) || 'claude-sonnet-5-5',
          max_tokens: Math.min(parseInt(b.max_tokens) || 8000, 8000),
          messages: b.messages
        })
      });
      resp = new Response(r.body, { status: r.status, headers: { ...cors, 'content-type': 'application/json' } });
    }
    if (ent.limit > 0 && resp.status === 200) {
      try { await env.QUOTA.put('u:' + code + ':' + month(), String(used + 1), { expirationTtl: 5184000 }); } catch (e) {}
    }
    return resp;
  }
};
