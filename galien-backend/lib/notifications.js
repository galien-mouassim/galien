const nodemailer = require('nodemailer');
const pool = require('../config/database');
const { parseEmailList } = require('./helpers');
const { ensureAppSettingsSchema } = require('./schema');

let loginAlertTransport = null;

function getLoginAlertRecipients() {
    return parseEmailList(process.env.LOGIN_ALERT_TO || process.env.ALERT_EMAIL_TO);
}

function buildLoginAlertTransport() {
    if (loginAlertTransport) return loginAlertTransport;
    const host = process.env.SMTP_HOST;
    const port = Number(process.env.SMTP_PORT || 587);
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    if (!host || !user || !pass) return null;
    loginAlertTransport = nodemailer.createTransport({
        host,
        port: Number.isFinite(port) ? port : 587,
        secure: Number(port) === 465,
        auth: { user, pass }
    });
    return loginAlertTransport;
}

function getLoginAlertConfigIssue() {
    const recipients = getLoginAlertRecipients();
    if (!recipients.length) return 'LOGIN_ALERT_TO is empty';
    if (!process.env.SMTP_HOST) return 'SMTP_HOST missing';
    if (!process.env.SMTP_USER) return 'SMTP_USER missing';
    if (!process.env.SMTP_PASS) return 'SMTP_PASS missing';
    return null;
}

async function getAppSettingBoolean(key, fallback = false) {
    try {
        await ensureAppSettingsSchema();
        const res = await pool.query(
            'SELECT value FROM app_settings WHERE key = $1',
            [key]
        );
        if (!res.rows.length) return fallback;
        const raw = String(res.rows[0].value || '').trim().toLowerCase();
        return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
    } catch (_) {
        return fallback;
    }
}

async function sendNonAdminLoginAlert({ user, req }) {
    if (!user || user.role === 'admin') return;
    const recipients = getLoginAlertRecipients();
    if (!recipients.length) {
        console.warn('Login alert skipped: LOGIN_ALERT_TO is empty');
        return;
    }
    const transporter = buildLoginAlertTransport();
    if (!transporter) {
        const issue = getLoginAlertConfigIssue() || 'SMTP transport not configured';
        console.warn(`Login alert skipped: ${issue}`);
        return;
    }

    const sender = process.env.SMTP_FROM || process.env.SMTP_USER;
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const ua = req.get('user-agent') || 'unknown';
    const timestamp = new Date().toISOString();

    try {
        await transporter.sendMail({
            from: sender,
            to: recipients.join(','),
            subject: '[Galien] Login non-admin detecte',
            text: [
                'Connexion non-admin detectee.',
                `Email: ${user.email}`,
                `Role: ${user.role}`,
                `User ID: ${user.id}`,
                `Date (UTC): ${timestamp}`,
                `IP: ${ip}`,
                `User-Agent: ${ua}`
            ].join('\n')
        });
        console.info(`Login alert email sent for non-admin user ${user.email}`);
    } catch (e) {
        console.error('Failed to send non-admin login alert:', e.message);
    }
}

async function notifyAdminsOfNonAdminLogin({ user, req }) {
    if (!user || user.role === 'admin') return;
    const enabled = await getAppSettingBoolean('non_admin_login_alert_enabled', true);
    if (!enabled) return;
    try {
        const admins = await pool.query(
            `SELECT id
             FROM users
             WHERE role = 'admin'`
        );
        if (!admins.rows.length) return;

        const ip = req.ip || req.socket?.remoteAddress || 'unknown';
        const ua = req.get('user-agent') || 'unknown';
        const body = [
            'Connexion non-admin detectee.',
            `Utilisateur: ${user.email}`,
            `Role: ${user.role}`,
            `Date (UTC): ${new Date().toISOString()}`,
            `IP: ${ip}`,
            `User-Agent: ${ua}`
        ].join('\n');

        const recipients = admins.rows
            .map((r) => Number(r.id))
            .filter((id) => Number.isInteger(id) && id > 0 && id !== Number(user.id));
        if (!recipients.length) return;

        const placeholders = [];
        const params = [];
        recipients.forEach((adminId, i) => {
            const base = i * 3;
            placeholders.push(`($${base + 1}, $${base + 2}, $${base + 3})`);
            params.push(Number(user.id), adminId, body);
        });

        await pool.query(
            `INSERT INTO user_messages (sender_id, recipient_id, body)
             VALUES ${placeholders.join(', ')}`,
            params
        );
    } catch (e) {
        console.error('Failed to create admin login notification:', e.message);
    }
}

module.exports = {
    getLoginAlertRecipients,
    buildLoginAlertTransport,
    getLoginAlertConfigIssue,
    getAppSettingBoolean,
    sendNonAdminLoginAlert,
    notifyAdminsOfNonAdminLogin
};
