import { BASE_URL, BROWSER_HEADERS, cleanToken, looksLikeAuthPage } from '../_lib/session.js';

export async function onRequest(context) {
    if (context.request.method !== 'POST') {
        return json({ error: 'Method Not Allowed', debug: [] }, 405);
    }
    if (!isAuthorized(context)) {
        return json({ error: 'Unauthorized', debug: [] }, 403);
    }

    const debug = [];
    const { DB } = context.env;

    let body;
    try {
        body = await context.request.json();
    } catch (err) {
        return json({ error: 'Failed to parse request body: ' + err.message, debug }, 400);
    }

    // Candidate cookies: one pasted in the request (manual fallback), then every
    // stored device session, newest first.
    const candidates = [];
    if (body.token) candidates.push({ token: cleanToken(body.token), device: 'manual-paste', stored: false });
    if (DB) {
        try {
            const rows = await DB.prepare('SELECT token, device FROM stuudium_sessions ORDER BY updated_at DESC').all();
            for (const r of rows.results) {
                if (!candidates.some(c => c.token === r.token)) {
                    candidates.push({ token: r.token, device: r.device, stored: true });
                }
            }
        } catch (err) {
            debug.push({ step: 'db_error', error: err.message });
        }
    }

    if (candidates.length === 0) {
        return json({ error: 'No session token yet', code: 'no_token', debug }, 400);
    }

    const baseUrl = BASE_URL;

    // 1. Fetch the dashboard page (redirects to /s/{id}) with the first cookie that still works
    let headers = null;
    let mainHtml = '';
    let pageUrl = `${baseUrl}/dashboard`;
    let lastError = null;

    for (const c of candidates) {
        const h = { ...BROWSER_HEADERS, 'Cookie': `_stdmss=${c.token}` };
        debug.push({ step: 'token', device: c.device, length: c.token.length, preview: `${c.token.slice(0, 12)}…${c.token.slice(-6)}` });
        try {
            const resp = await fetch(`${baseUrl}/dashboard`, { headers: h, redirect: 'follow' });
            const html = await resp.text();
            const isAuthPage = looksLikeAuthPage(resp.url, html);
            debug.push({ step: 'dashboard', status: resp.status, finalUrl: resp.url, htmlLength: html.length, isAuthPage });

            if (isAuthPage) {
                // dead cookie: forget it so we do not retry it every sync
                if (c.stored && DB) {
                    await DB.prepare('DELETE FROM stuudium_sessions WHERE token = ?').bind(c.token).run().catch(() => {});
                }
                continue;
            }
            headers = h;
            mainHtml = html;
            pageUrl = resp.url;
            break;
        } catch (err) {
            debug.push({ step: 'dashboard_error', error: err.message });
            lastError = err;
        }
    }

    if (!headers) {
        if (lastError) return json({ error: 'Failed to reach dashboard: ' + lastError.message, debug }, 500);
        return json({ error: 'Session expired — please update your token', debug }, 401);
    }

    // 2. Find all data-action="load-older" links in the main HTML.
    //    The scheduled section is rendered inline but tasks are fetched via this link.
    //    Note: URLs in HTML are &amp;-encoded, so unescape them.
    const olderElements = [...mainHtml.matchAll(/<[^>]+data-action="load-older"[^>]*>/g)];
    const olderUrls = [...new Set(
        olderElements
            .map(m => {
                const u = m[0].match(/data-url="([^"]+)"/);
                return u ? u[1].replace(/&amp;/g, '&') : null;
            })
            .filter(Boolean)
    )];

    debug.push({ step: 'older_links', count: olderUrls.length, urls: olderUrls });

    // 3. Fetch each older-tasks fragment
    const refHeaders = { ...headers, 'Referer': pageUrl };
    const fragments = [];

    for (const relUrl of olderUrls) {
        const fullUrl = relUrl.startsWith('http') ? relUrl : `${baseUrl}${relUrl}`;
        try {
            const resp = await fetch(fullUrl, { headers: refHeaders, redirect: 'follow' });
            if (resp.ok) {
                const html = await resp.text();
                fragments.push(html);
                debug.push({
                    step: 'older_fetch',
                    url: relUrl.slice(0, 80) + '…',
                    status: resp.status,
                    htmlLength: html.length,
                    todoContainerCount: (html.match(/todo_container/g) || []).length,
                });
            } else {
                debug.push({ step: 'older_fetch_failed', url: relUrl.slice(0, 80), status: resp.status });
            }
        } catch (e) {
            debug.push({ step: 'older_fetch_error', url: relUrl.slice(0, 80), error: e.message });
        }
    }

    // 4. Also parse the main HTML itself in case some current tasks are inline
    fragments.push(mainHtml);

    // 5. Parse tasks from all fragments
    const taskMap = new Map();
    fragments.forEach((html, i) => {
        parseTasksFromHTML(html, debug, i === fragments.length - 1 ? 'main' : `older_${i}`)
            .forEach(t => taskMap.set(t.id, t));
    });

    const tasks = Array.from(taskMap.values())
        .sort((a, b) => parseInt(b.date || 0) - parseInt(a.date || 0));

    debug.push({ step: 'done', fragmentsFetched: fragments.length, tasksFound: tasks.length });

    return json({ tasks, count: tasks.length, debug });
}

function parseTasksFromHTML(html, debug, source) {
    const tasks = [];
    if (!html) return tasks;

    const parts = html.split(/(?=<div[^>]+class="[^"]*\btodo_container\b[^"]*")/);
    const withContainer = parts.filter(p => p.includes('todo_container'));

    if (withContainer.length > 0 || source === 'main') {
        debug.push({ step: `parse_${source}`, parts: parts.length, withTodoContainer: withContainer.length });
    }

    for (const part of withContainer) {
        const task = {};

        const idMatch = part.match(/data-k="([^"]+)"/) || part.match(/data-id="([^"]+)"/);
        task.id = idMatch ? idMatch[1] : null;

        const hashMatch = part.match(/data-k-hsh="([^"]+)"/) || part.match(/data-hash="([^"]+)"/);
        task.hash = hashMatch ? hashMatch[1] : null;

        // Prefer data-date_ts (Unix seconds); fall back to parsing YYYYMMDD from data-date
        const dateTsMatch = part.match(/data-date_ts="([^"]+)"/);
        if (dateTsMatch) {
            task.date = dateTsMatch[1];
        } else {
            const dateMatch = part.match(/data-date="([^"]+)"/);
            if (dateMatch && dateMatch[1].length === 8) {
                const s = dateMatch[1];
                const ts = Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)) / 1000;
                task.date = String(ts);
            }
        }

        task.completed =
            /todo_container[^"]*is_marked/.test(part) ||
            /class="[^"]*is_marked[^"]*"/.test(part);

        const contentMatch = part.match(/class="[^"]*todo_content[^"]*"[^>]*>([\s\S]*?)<\/(?:div|span|p)>/);
        task.description = contentMatch ? stripTags(contentMatch[1]).trim() : null;

        // Subject is in <a class="subject_name">
        const subjectMatch = part.match(/class="subject_name"[^>]*>([\s\S]*?)<\/a>/);
        task.subject = subjectMatch ? stripTags(subjectMatch[1]).trim() : 'Unknown';

        const durationMatch = part.match(/class="[^"]*todo_duration[^"]*"[^>]*>([\s\S]*?)<\/(?:div|span|p)>/);
        task.duration = durationMatch ? stripTags(durationMatch[1]).trim() : '';

        if (task.id && task.description) {
            tasks.push(task);
        } else {
            debug.push({
                step: `parse_${source}_skip`,
                reason: !task.id ? 'no id' : 'no description',
                snippet: part.slice(0, 150).replace(/\s+/g, ' '),
            });
        }
    }

    return tasks;
}

function stripTags(html) {
    return html
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ')
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)))
        .replace(/&([a-zA-Z]+);/g, decodeNamedEntity)
        .replace(/\s+/g, ' ')
        .trim();
}

function decodeNamedEntity(match, name) {
    const entities = {
        auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü',
        otilde: 'õ', Otilde: 'Õ', atilde: 'ã', ntilde: 'ñ',
        eacute: 'é', ecirc: 'ê', egrave: 'è', Eacute: 'É',
        aacute: 'á', acirc: 'â', agrave: 'à',
        iacute: 'í', icirc: 'î', igrave: 'ì',
        oacute: 'ó', ocirc: 'ô', ograve: 'ò',
        uacute: 'ú', ucirc: 'û', ugrave: 'ù',
        ccedil: 'ç', Ccedil: 'Ç',
        szlig: 'ß', aelig: 'æ', AElig: 'Æ',
        copy: '©', reg: '®', trade: '™',
        mdash: '—', ndash: '–', hellip: '…',
        laquo: '«', raquo: '»',
    };
    return entities[name] || match;
}

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

function isAuthorized(context) {
    const token = context.request.headers.get('X-App-Token');
    return context.env.PASSWORD && token === context.env.PASSWORD;
}
