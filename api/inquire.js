// Broker inquiries sent directly from your Gmail (no more mailto hand-off).
//
// Setup (Vercel env vars):
//   GMAIL_USER          e.g. bizbo0314@gmail.com
//   GMAIL_APP_PASSWORD  Google Account → Security → 2-Step Verification → App passwords
//
// GET  → { enabled, from }  (feature detection for the UI)
// POST { to, subject, body } → sends via Gmail SMTP (limit ~500/day on free Gmail)

import nodemailer from "nodemailer";

const enabled = () => !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "GET") {
    return res.status(200).json({
      enabled: enabled(),
      from: enabled() ? process.env.GMAIL_USER : null,
      ...(enabled() ? {} : { message: "Add GMAIL_USER + GMAIL_APP_PASSWORD in Vercel to send inquiries directly." }),
    });
  }

  if (req.method !== "POST") return res.status(405).json({ error: "GET or POST only" });
  if (!enabled()) return res.status(501).json({ enabled: false, error: "gmail_not_configured" });

  const { to, subject, body } = req.body || {};
  if (!to || !EMAIL_RE.test(String(to).trim())) return res.status(400).json({ error: "valid 'to' email required" });
  if (!subject || !body) return res.status(400).json({ error: "subject and body required" });

  try {
    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    });
    const info = await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to: String(to).trim(),
      subject: String(subject).slice(0, 300),
      text: String(body).slice(0, 20000),
    });
    return res.status(200).json({ ok: true, messageId: info.messageId });
  } catch (err) {
    return res.status(502).json({ error: "send_failed", detail: String(err && err.message ? err.message : err) });
  }
}
