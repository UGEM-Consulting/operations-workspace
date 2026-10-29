/**
 * The one layout every email uses: a "UGEM Workspace" text header, the message, an optional code or link, and a
 * footer. Inline styles and a single centred table, because many mail apps ignore <style> blocks and modern CSS.
 * Callers pass fixed template text; anything dynamic (codes, references, links) is checked by the caller and escaped here.
 */
export interface EmailContent {
  subject: string;
  /** Short paragraphs of fixed text. */
  paragraphs: string[];
  /** A one-time code or reference shown large and monospaced (below any link), followed by `after`. */
  code?: string;
  after?: string[];
  /** A link written out in full (plain-text readers see the same address). */
  link?: { lead: string; url: string };
  /** Small print under the message. */
  note?: string;
}
const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
const BRAND = '#e04808';
const INK = '#211f1d';
const MUTED = '#6b6561';
const FOOTER = 'This is an automated message from UGEM Workspace; replies are not monitored.';

export function renderEmail(content: EmailContent) {
  const text = [
    ...content.paragraphs.flatMap(paragraph => [paragraph, '']),
    ...(content.link ? [content.link.lead, content.link.url, ''] : []),
    ...(content.code ? [content.code, ''] : []),
    ...(content.after ?? []).flatMap(paragraph => [paragraph, '']),
    ...(content.note ? [content.note, ''] : []),
    '—',
    FOOTER,
  ].join('\n');
  const paragraph = (value: string) => `<p style="margin:0 0 16px;font-size:15px;line-height:24px;color:${INK}">${escape(value)}</p>`;
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f5f3f1">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f3f1"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e6e2de;border-radius:8px;font-family:Arial,Helvetica,sans-serif">
<tr><td style="padding:20px 28px;border-bottom:3px solid ${BRAND};font-size:16px;font-weight:bold;letter-spacing:0.5px;color:${INK}">UGEM Workspace</td></tr>
<tr><td style="padding:28px">
${content.paragraphs.map(paragraph).join('\n')}
${content.link ? `<p style="margin:0 0 8px;font-size:15px;line-height:24px;color:${INK}">${escape(content.link.lead)}</p><p style="margin:0 0 16px;font-size:15px;line-height:24px"><a href="${escape(content.link.url)}" style="color:${BRAND}">${escape(content.link.url)}</a></p>` : ''}
${content.code ? `<p style="margin:4px 0 20px;font-family:'Courier New',monospace;color:${INK};word-break:break-all;${content.code.length > 12 ? 'font-size:15px;line-height:22px' : 'font-size:28px;line-height:36px;font-weight:bold;letter-spacing:4px'}">${escape(content.code)}</p>` : ''}
${(content.after ?? []).map(paragraph).join('\n')}
${content.note ? `<p style="margin:8px 0 0;font-size:13px;line-height:20px;color:${MUTED}">${escape(content.note)}</p>` : ''}
</td></tr>
<tr><td style="padding:16px 28px;border-top:1px solid #e6e2de;font-size:12px;line-height:18px;color:${MUTED}">${FOOTER}<br>UGEM Consulting</td></tr>
</table></td></tr></table>
</body></html>`;
  return { subject: content.subject, text, html };
}
