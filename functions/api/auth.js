export async function onRequestPost(context) {
    let body;
    try {
        body = await context.request.json();
    } catch {
        return json({ error: 'Invalid request body' }, 400);
    }

    const { password } = body;
    const expected = context.env.PASSWORD;

    if (!expected) {
        return json({ error: 'PASSWORD environment variable not set on server' }, 500);
    }

    if (password === expected) {
        return json({ ok: true });
    }
    return json({ ok: false }, 401);
}

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}
