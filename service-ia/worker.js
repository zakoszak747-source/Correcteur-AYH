// Service IA partagé (Cloudflare Worker).
// Utilise Google Gemini si la variable GEMINI_API_KEY existe, sinon Claude (ANTHROPIC_API_KEY).
// Variables à créer dans Cloudflare (type Secret) :
//   GEMINI_API_KEY  (ou ANTHROPIC_API_KEY)
//   ACCESS_CODES    (codes d'accès séparés par des virgules)
// Facultatif : GEMINI_MODEL (par défaut gemini-2.5-flash), MODEL (modèle Claude).
const clean = v => String(v || '').trim().replace(/^["']|["']$/g, '');

async function gemini(b, key, env, json) {
  const parts = [];
  for (const m of b.messages) {
    const c = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : (m.content || []);
    for (const p of c) {
      if (p.type === 'text') parts.push({ text: p.text });
      else if (p.type === 'image' && p.source) parts.push({ inline_data: { mime_type: p.source.media_type || 'image/jpeg', data: p.source.data } });
    }
  }
  const model = clean(env.GEMINI_MODEL) || 'gemini-2.5-flash';
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: { maxOutputTokens: 8192, temperature: 0.2 }
    })
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
      'Access-Control-Allow-Methods': 'POST,OPTIONS'
    };
    const json = (o, s) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, 'content-type': 'application/json' } });
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (req.method !== 'POST') return new Response('Service IA AYH : en ligne', { headers: cors });

    const code = (req.headers.get('x-access-code') || '').trim();
    const ok = (env.ACCESS_CODES || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!code || !ok.includes(code)) return json({ error: 'code refusé' }, 401);

    let b;
    try { b = await req.json(); } catch (e) { return json({ error: 'requête invalide' }, 400); }
    if (!Array.isArray(b.messages)) return json({ error: 'requête invalide' }, 400);

    const gk = clean(env.GEMINI_API_KEY), ak = clean(env.ANTHROPIC_API_KEY);
    if (gk) return gemini(b, gk, env, json);
    if (!ak) return json({ error: 'clé absente : crée la variable GEMINI_API_KEY (ou ANTHROPIC_API_KEY) dans ce Worker' }, 500);

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': ak, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: clean(env.MODEL) || 'claude-sonnet-5-5',
        max_tokens: Math.min(parseInt(b.max_tokens) || 8000, 8000),
        messages: b.messages
      })
    });
    return new Response(r.body, { status: r.status, headers: { ...cors, 'content-type': 'application/json' } });
  }
};
