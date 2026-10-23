export async function onRequest(context) {
    if (context.request.method !== 'POST') {
        return json({ error: 'Method Not Allowed' }, 405);
    }
    if (!isAuthorized(context)) return json({ error: 'Unauthorized' }, 401);

    const { DB } = context.env;
    if (!DB) return json({ error: 'D1 not configured' }, 500);
    // Revoke the grant at Google too (best effort), so no old permission lingers in your Google account.
    try {
        const row = await DB.prepare('SELECT refresh_token FROM google_tokens WHERE id = 1').first();
        if (row?.refresh_token) {
            await fetch('https://oauth2.googleapis.com/revoke', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ token: row.refresh_token }),
            });
        }
    } catch { /* ignore: tokens are removed below either way */ }
    await DB.prepare('DELETE FROM google_tokens WHERE id = 1').run();
    await DB.prepare('DELETE FROM calendar_events').run();
    await DB.prepare('DELETE FROM calendar_event_state').run().catch(() => {});
    return json({ ok: true });
}

function isAuthorized(context) {
    const token = context.request.headers.get('X-App-Token');
    return context.env.PASSWORD && token === context.env.PASSWORD;
}

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}
