// /api/notify-lead — Vercel serverless function
// Receives lead/form/demo events, inserts into Supabase, emails the owner via Resend.
import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';

const supabase = createClient(process.env.VITE_SUPABASE_URL || 'https://hctpvnqanwhxlmpmfmme.supabase.co', (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY)!);
const resend = new Resend(process.env.RESEND_API_KEY || 're_PrBqU13q_CbS4xeiqtyXk1tdhgKYuYhVb'); // SECURITY: server-side only, never expose

export default async function handler(req: any, res: any) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ ok: false });
    const { name, practice_name, email, phone, country, monthly_call_volume, locations, source } = req.body || {};
    if (!['form', 'demo_call', 'exit_intent'].includes(source)) return res.status(200).json({ ok: false });

    await supabase.from('leads').insert({ name, practice_name, email, phone, country, monthly_call_volume, locations, source });

    const qualified = ['200–500', '500–1,000', '1,000+'].includes(monthly_call_volume) || parseInt(locations, 10) > 1;
    const leadSummaryHtml = `
      <h2>Digi Dental — new ${source === 'demo_call' ? 'demo call' : 'lead'}</h2>
      <p><strong>Name:</strong> ${name || '—'}<br>
      <strong>Practice:</strong> ${practice_name || '—'}<br>
      <strong>Email:</strong> ${email || '—'} &nbsp; <strong>Phone:</strong> ${phone || '—'}<br>
      <strong>Country:</strong> ${country || '—'} &nbsp; <strong>Calls/mo:</strong> ${monthly_call_volume || '—'} &nbsp; <strong>Locations:</strong> ${locations || '—'}<br>
      <strong>Source:</strong> ${source} &nbsp; <strong>At:</strong> ${new Date().toISOString()}<br>
      <strong>Qualification:</strong> ${qualified ? 'Fit (volume or multi-location)' : 'Smaller practice'}</p>`;

    await resend.emails.send({
      from: 'onboarding@resend.dev', // PLACEHOLDER — replace with verified custom domain sender before launch
      to: process.env.NOTIFY_EMAIL_TO || 'bennysworkspace@gmail.com',
      subject: source === 'demo_call' ? 'Digi Dental: demo call completed' : `New Digi Dental lead: ${practice_name || name || 'unnamed'} (${monthly_call_volume || '?'} calls/mo)`,
      html: leadSummaryHtml,
    });
    return res.status(200).json({ ok: true });
  } catch {
    return res.status(200).json({ ok: false }); // graceful — client never surfaces a raw error
  }
}
