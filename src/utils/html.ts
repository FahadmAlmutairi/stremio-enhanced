const HTML_ESCAPES: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
};

/**
 * Escape a value before inserting it into an HTML template (text or a quoted attribute).
 * Use this for anything that comes from mod metadata, file names, the registry, streams or plugins.
 */
export function escapeHtml(value: unknown): string {
    return String(value ?? '').replace(/[&<>"']/g, char => HTML_ESCAPES[char]);
}

/**
 * Returns the URL if it is http(s), otherwise an empty string.
 * Prevents `javascript:` and similar URLs in href/src attributes. Still escape the result.
 */
export function safeUrl(value: unknown): string {
    try {
        const url = new URL(String(value));
        return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
    } catch {
        return '';
    }
}
