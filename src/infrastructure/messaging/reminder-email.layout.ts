import { BRAND, type EmailCopy } from '@domain/booking/reminder-message';

/**
 * The reminder email, as HTML and as plain text.
 *
 * A HAND PORT of gostyle-platform's email-layout.ts -- the black sheet, the
 * wordmark, the hairline rules, the footer -- the same way customer-api's
 * emails.py ported it, so a reminder looks like every other GoStyle email.
 * Table layout and inline styles throughout: Outlook and most webmail strip
 * <style> and ignore flexbox.
 *
 * EVERY VALUE IS ESCAPED. A customer's name and a service name are text
 * someone typed; neither gets to become markup in somebody's inbox.
 */

/** The GoStyle wordmark, the same asset the platform's emails use. */
const BRAND_LOGO_URL =
  'https://entity-blob-storage.s3.eu-north-1.amazonaws.com/tenants/00000000-0000-0000-0000-000000000001/uploads/1788430458845-u9ffb37yqed.png';

const INK = '#FFFFFF';
const BODY_TEXT = '#C9C9C9';
const MUTED_TEXT = '#8A8A8A';
const RULE_COLOR = '#2A2A2A';
const SHEET_BG = '#000000';
const FONT = 'Helvetica,Arial,sans-serif';

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function rule(): string {
  return `
          <tr>
            <td class="pad" style="padding:0 48px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr><td height="1" style="height:1px; line-height:1px; font-size:0; background-color:${RULE_COLOR};">&nbsp;</td></tr>
              </table>
            </td>
          </tr>`;
}

function paragraph(text: string, color = BODY_TEXT): string {
  return `
          <tr>
            <td class="pad" style="padding:0 48px 16px 48px; font-family:${FONT}; font-size:15px; line-height:24px; color:${color};">${escapeHtml(text)}</td>
          </tr>`;
}

function detailsTable(details: EmailCopy['details']): string {
  const rows = details
    .map(
      (d) => `
                <tr>
                  <td style="padding:8px 0; font-family:${FONT}; font-size:13px; line-height:20px; color:${MUTED_TEXT}; width:40%; vertical-align:top;">${escapeHtml(d.label)}</td>
                  <td style="padding:8px 0; font-family:${FONT}; font-size:15px; line-height:20px; color:${INK}; vertical-align:top;">${escapeHtml(d.value)}</td>
                </tr>`,
    )
    .join('');
  return `
          <tr>
            <td class="pad" style="padding:8px 48px 24px 48px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}
              </table>
            </td>
          </tr>`;
}

export function renderReminderEmail(
  copy: EmailCopy,
  year: number,
): { html: string; text: string } {
  const body = [
    `
          <tr>
            <td class="pad headline" style="padding:32px 48px 16px 48px; font-family:${FONT}; font-size:28px; line-height:34px; font-weight:bold; color:${INK};">${escapeHtml(copy.heading)}</td>
          </tr>`,
    paragraph(copy.greeting, INK),
    ...copy.lines.map((l) => paragraph(l)),
    rule(),
    detailsTable(copy.details),
    ...copy.notes.map((n) => paragraph(n, INK)),
  ].join('');

  const html = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="x-apple-disable-message-reformatting" />
  <title>${escapeHtml(copy.subject)}</title>
  <style type="text/css">
    body, table, td, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
    table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; border-collapse: collapse; }
    img { -ms-interpolation-mode: bicubic; border: 0; outline: none; text-decoration: none; }
    body { margin: 0 !important; padding: 0 !important; width: 100% !important; }
    @media only screen and (max-width: 600px) {
      .sheet    { width: 100% !important; }
      .pad      { padding-left: 24px !important; padding-right: 24px !important; }
      .headline { font-size: 24px !important; }
    }
  </style>
</head>
<body style="margin:0; padding:0;">
  <div style="display:none; font-size:1px; line-height:1px; max-height:0; max-width:0; opacity:0; overflow:hidden; mso-hide:all;">${escapeHtml(copy.preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr>
      <td align="center" style="padding:40px 12px;">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" class="sheet" style="width:560px; max-width:560px; background-color:${SHEET_BG}; border-radius:12px;">
          <tr>
            <td align="center" style="padding:36px 48px 24px 48px; background-color:${SHEET_BG}; border-radius:12px 12px 0 0;">
              <img src="${BRAND_LOGO_URL}" width="120" alt="${BRAND}" style="display:block; border:0; max-width:120px; height:auto; margin:0 auto;" />
            </td>
          </tr>${rule()}${body}${rule()}
          <tr>
            <td class="pad" align="left" style="padding:20px 48px 40px 48px; font-family:${FONT}; font-size:12px; line-height:20px; color:${MUTED_TEXT}; border-radius:0 0 12px 12px;">
              Automated message from ${BRAND}. Replies to this address are not read.<br />
              &copy; ${year} ${BRAND}. All rights reserved.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const text = [
    copy.greeting,
    '',
    ...copy.lines,
    '',
    ...copy.details.map((d) => `${d.label}: ${d.value}`),
    ...(copy.notes.length > 0 ? ['', ...copy.notes] : []),
    '',
    `Automated message from ${BRAND}. Replies to this address are not read.`,
  ].join('\n');

  return { html, text };
}
