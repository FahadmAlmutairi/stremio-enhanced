import TemplateCache from '../../utils/templateCache';
import { escapeHtml } from '../../utils/html';

export function getPromptModalTemplate(
    promptId: string,
    title: string,
    message: string,
    defaultValue?: string
): string {
    const modalId = escapeHtml(`prompt-modal-${promptId}`);

    const html = TemplateCache.load(__dirname, 'prompt-modal')
        .replace(/\{\{\s*modalId\s*\}\}/g, () => modalId)
        .replace(/\{\{\s*title\s*\}\}/g, () => escapeHtml(title))
        .replace(/\{\{\s*message\s*\}\}/g, () => escapeHtml(message))
        .replace(/\{\{\s*defaultValue\s*\}\}/g, () => escapeHtml(defaultValue));

    return html;
}
