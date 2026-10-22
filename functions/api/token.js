// Stores Stuudium session cookies (one per device) in D1.
//   POST { token, device }  -> verify against Stuudium, then save
//   GET                      -> list stored sessions (device + time, never the cookie itself)
// Protected by the same X-App-Token (= PASSWORD) check as the other endpoints.

import { cleanToken, checkSession } from '../_lib/session.js';

const MAX_SESSIONS = 5;

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-App-Token',
};

export async function onRequest(context) {
    const { request, env } = context;

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const appToken = request.headers.get('X-App-Token');
    if (!env.PASSWORD || appToken !== env.PASSWORD) return json({ error: 'Unauthorized' }, 401);
    if (!env.DB) return json({ error: 'D1 database not configured' }, 500);

    if (request.method === 'GET') {
        try {
            const rows = await env.DB
                .prepare('SELECT device, updated_at FROM stuudium_sessions ORDER BY updated_at DESC')
                .all();
            return json({ count: rows.results.length, sessions: rows.results });
        } catch (err) {
            return json({ error: 'DB error (did you run schema.sql?): ' + err.message }, 500);
        }
    }

    if (request.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405);

    let body;
    try {
        body = await request.json();
    } catch {
        return json({ error: 'Invalid JSON body' }, 400);
    }

    const token = cleanToken(body.token);
    if (!token) return json({ error: 'No token provided' }, 400);

    const device = String(body.device || 'manual').replace(/[^\w .\-]/g, '').slice(0, 40) || 'manual';

    let valid;
    try {
        valid = await checkSession(token);
    } catch (err) {
        return json({ error: 'Could not reach Stuudium: ' + err.message }, 502);
    }
    if (!valid) return json({ ok: false, error: 'Stuudium rejected this cookie (expired or not logged in)' }, 422);

    try {
        await env.DB.batch([
            env.DB.prepare(
                `INSERT INTO stuudium_sessions (token, device, updated_at) VALUES (?1, ?2, unixepoch())
                 ON CONFLICT(token) DO UPDATE SET device = ?2, updated_at = unixepoch()`
            ).bind(token, device),
            // a device only keeps its newest cookie
            env.DB.prepare('DELETE FROM stuudium_sessions WHERE device = ?1 AND token != ?2').bind(device, token),
            env.DB.prepare(
                `DELETE FROM stuudium_sessions WHERE token NOT IN
                 (SELECT token FROM stuudium_sessions ORDER BY updated_at DESC LIMIT ${MAX_SESSIONS})`
            ),
        ]);
    } catch (err) {
        return json({ error: 'DB error (did you run schema.sql?): ' + err.message }, 500);
    }

    return json({ ok: true, device });
}

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', ...CORS },
    });
}
