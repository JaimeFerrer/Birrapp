// Envío de correos con Brevo (https://www.brevo.com), plan gratuito de 300
// correos al día. Sin BREVO_API_KEY (en local o en los tests) el correo se
// escribe en la consola en lugar de enviarse.
function createMailer({ apiKey = process.env.BREVO_API_KEY, from = process.env.MAIL_FROM } = {}) {
  return async function sendMail({ to, subject, text, html }) {
    if (!apiKey || !from) {
      console.log(`[correo no enviado: falta BREVO_API_KEY o MAIL_FROM]\nPara: ${to}\nAsunto: ${subject}\n${text}`);
      return;
    }
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        sender: { email: from, name: 'Birrapp' },
        to: [{ email: to }],
        subject,
        textContent: text,
        htmlContent: html,
      }),
    });
    if (!res.ok) {
      throw new Error(`Brevo respondió ${res.status}: ${await res.text()}`);
    }
  };
}

module.exports = { createMailer };
