require('dotenv').config();
const express  = require('express');
const path     = require('path');
const { Pool } = require('pg');
const basicAuth = require('express-basic-auth');

const app  = express();
const PORT = process.env.PORT || 3000;
const ADMIN_USER = process.env.ADMIN_USER     || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'sharpening2024';

// ── Postgres pool ──────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.POSTGRES_URL || process.env.DATABASE_URL || process.env.STORAGE_URL,
  ssl: { rejectUnauthorized: false },
  max: 1,
});

// Create table on first cold start (idempotent — safe to run every boot)
pool.query(`
  CREATE TABLE IF NOT EXISTS contacts (
    id                       SERIAL PRIMARY KEY,
    created_at               TIMESTAMPTZ DEFAULT NOW(),
    updated_at               TIMESTAMPTZ DEFAULT NOW(),
    first_name               TEXT NOT NULL,
    last_name                TEXT NOT NULL,
    preferred_name           TEXT,
    email                    TEXT NOT NULL,
    phone                    TEXT,
    address                  TEXT,
    city                     TEXT,
    state                    TEXT,
    zip                      TEXT,
    date_of_birth            TEXT,
    roles                    TEXT NOT NULL DEFAULT '[]',
    student_name             TEXT,
    student_grade            TEXT,
    student_school           TEXT,
    parent_contact_name      TEXT,
    parent_contact_phone     TEXT,
    occupation               TEXT,
    church                   TEXT,
    mentor_experience        TEXT,
    availability             TEXT,
    background_check_consent BOOLEAN DEFAULT FALSE,
    organization             TEXT,
    giving_interest          TEXT,
    how_heard                TEXT,
    message                  TEXT,
    status                   TEXT DEFAULT 'new',
    notes                    TEXT DEFAULT ''
  );
`).catch(err => console.error('DB init error:', err.message));

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Admin auth ─────────────────────────────────────────────────────────────────
const adminAuth = basicAuth({
  users: { [ADMIN_USER]: ADMIN_PASS },
  challenge: true,
  realm: 'Sharpening Project CRM',
});

// ── Static files ───────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.path === '/admin.html') return res.status(403).send('Forbidden');
  next();
});
app.use(express.static(__dirname));

// Explicit root route — serves index.html for /
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Form submission ────────────────────────────────────────────────────────────
app.post('/api/submit', async (req, res) => {
  try {
    const b = req.body;
    if (!b.first_name || !b.last_name || !b.email) {
      return res.status(400).json({ error: 'First name, last name, and email are required.' });
    }
    const roles = Array.isArray(b.roles) ? b.roles : [b.roles].filter(Boolean);

    await pool.query(
      `INSERT INTO contacts (
        first_name, last_name, preferred_name, email, phone,
        address, city, state, zip, date_of_birth,
        roles,
        student_name, student_grade, student_school,
        parent_contact_name, parent_contact_phone,
        occupation, church, mentor_experience, availability, background_check_consent,
        organization, giving_interest,
        how_heard, message
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
        $12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
        $22,$23,$24,$25
      )`,
      [
        b.first_name, b.last_name, b.preferred_name || null, b.email, b.phone || null,
        b.address || null, b.city || null, b.state || null, b.zip || null, b.date_of_birth || null,
        JSON.stringify(roles),
        b.student_name || null, b.student_grade || null, b.student_school || null,
        b.parent_contact_name || null, b.parent_contact_phone || null,
        b.occupation || null, b.church || null, b.mentor_experience || null,
        b.availability || null, !!b.background_check_consent,
        b.organization || null, b.giving_interest || null,
        b.how_heard || null, b.message || null,
      ]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Submit error:', err.message);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// ── Admin panel ────────────────────────────────────────────────────────────────
app.get('/admin', adminAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// Export CSV — must come before /:id
app.get('/api/contacts/export', adminAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM contacts ORDER BY created_at DESC');
    const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const headers = [
      'ID','Submitted','First Name','Last Name','Preferred Name','Email','Phone',
      'Address','City','State','ZIP','Date of Birth','Roles','Status','Notes',
      'Student Name','Student Grade','Student School',
      'Parent Contact Name','Parent Contact Phone',
      'Occupation','Church','Mentor Experience','Availability','BG Check Consent',
      'Organization','Giving Interest','How Heard','Message',
    ];
    const csv = [
      headers.map(esc).join(','),
      ...rows.map(c => [
        c.id, c.created_at,
        c.first_name, c.last_name, c.preferred_name,
        c.email, c.phone, c.address, c.city, c.state, c.zip, c.date_of_birth,
        JSON.parse(c.roles || '[]').join('; '),
        c.status, c.notes,
        c.student_name, c.student_grade, c.student_school,
        c.parent_contact_name, c.parent_contact_phone,
        c.occupation, c.church, c.mentor_experience, c.availability,
        c.background_check_consent ? 'Yes' : 'No',
        c.organization, c.giving_interest, c.how_heard, c.message,
      ].map(esc).join(',')),
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="sharpening-contacts.csv"');
    res.send(csv);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Export failed.' });
  }
});

// List all contacts
app.get('/api/contacts', adminAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM contacts ORDER BY created_at DESC');
    res.json(rows.map(c => ({ ...c, roles: JSON.parse(c.roles || '[]') })));
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch contacts.' });
  }
});

// Single contact
app.get('/api/contacts/:id', adminAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM contacts WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const c = rows[0];
    res.json({ ...c, roles: JSON.parse(c.roles || '[]') });
  } catch (err) {
    res.status(500).json({ error: 'Failed.' });
  }
});

// Update contact (status and/or notes)
app.patch('/api/contacts/:id', adminAuth, async (req, res) => {
  try {
    const { status, notes } = req.body;
    const parts = [], vals = [];
    let idx = 1;
    if (status !== undefined) { parts.push(`status = $${idx++}`); vals.push(status); }
    if (notes  !== undefined) { parts.push(`notes = $${idx++}`);  vals.push(notes);  }
    if (!parts.length) return res.status(400).json({ error: 'Nothing to update' });
    parts.push(`updated_at = NOW()`);
    vals.push(req.params.id);
    await pool.query(`UPDATE contacts SET ${parts.join(', ')} WHERE id = $${idx}`, vals);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Update failed.' });
  }
});

// Delete contact
app.delete('/api/contacts/:id', adminAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM contacts WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Delete failed.' });
  }
});

// ── Local dev: listen as normal server
//    Vercel: export `app` as the serverless handler
// ─────────────────────────────────────────────────────────────────────────────
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`
  ✦  The Sharpening Project
  ─────────────────────────────────────────
  Website:  http://localhost:${PORT}
  Admin:    http://localhost:${PORT}/admin
  Login:    ${ADMIN_USER} / ${ADMIN_PASS}
  ─────────────────────────────────────────
    `);
  });
}

module.exports = app;
