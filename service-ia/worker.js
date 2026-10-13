// Service IA partagé (Cloudflare Worker). La clé reste ici, jamais dans l'application.
// Variables à créer dans Cloudflare : ANTHROPIC_API_KEY (secret) et ACCESS_CODES (secret, codes séparés par des virgules).
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
    const body = {
      model: env.MODEL || 'claude-sonnet-5-5',
      max_tokens: Math.min(parseInt(b.max_tokens) || 8000, 8000),
      messages: b.messages
    };
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body)
    });
    return new Response(r.body, { status: r.status, headers: { ...cors, 'content-type': 'application/json' } });
  }
};
