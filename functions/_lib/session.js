// Shared helpers for the Stuudium session cookie (_stdmss).
// No onRequest export here, so Pages does not turn this file into a route.

export const BASE_URL = 'https://jpg.ope.ee';

export const BROWSER_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'et-EE,et;q=0.9,en-US;q=0.8,en;q=0.7',
    'Referer': 'https://jpg.ope.ee/',
};

export function cleanToken(raw) {
    let t = String(raw || '').trim();
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
        t = t.slice(1, -1);
    } else if (t.endsWith('"') || t.endsWith("'")) {
        t = t.slice(0, -1);
    }
    if (t.includes('%')) {
        try { t = decodeURIComponent(t); } catch (_) {}
    }
    return t;
}

export function looksLikeAuthPage(finalUrl, html) {
    return finalUrl.includes('/auth') || finalUrl.includes('/login') || html.includes('Sisene');
}

// true if Stuudium still accepts this cookie, false if it bounces to the login page
export async function checkSession(token) {
    const resp = await fetch(`${BASE_URL}/dashboard`, {
        headers: { ...BROWSER_HEADERS, Cookie: `_stdmss=${token}` },
        redirect: 'follow',
    });
    const html = await resp.text();
    return resp.ok && !looksLikeAuthPage(resp.url, html);
}
