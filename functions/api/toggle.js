export async function onRequestPost(context) {
    try {
        const { phpsessid, id, hash, state } = await context.request.json();

        if (!phpsessid || !id || !hash) {
            return json({ error: 'Missing required fields' }, 400);
        }

        const body = `k=${encodeURIComponent(id)}&hsh=${encodeURIComponent(hash)}&state=${state}`;

        const response = await fetch('https://jpg.ope.ee/dashboard/recent_data/scheduled_mark', {
            method: 'POST',
            headers: {
                'Cookie': `_stdmss=${phpsessid}`,
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            },
            body
        });

        const text = await response.text();
        return json({ ok: text === '1' || response.ok });

    } catch (err) {
        return json({ error: err.message }, 500);
    }
}

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}
