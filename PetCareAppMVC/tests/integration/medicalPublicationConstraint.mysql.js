// Run only with PETHUB_ISOLATED_MYSQL_DATADIR set to the disposable server's
// exact data directory and that server listening on loopback port 23316.
// Creates test fixtures, not a migration; never targets the petcare database.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const mysql = require('mysql2/promise');

async function main() {
  const expected = process.env.PETHUB_ISOLATED_MYSQL_DATADIR;
  if (!expected || !path.isAbsolute(expected)) throw new Error('Specify the isolated server data directory.');
  const connection = await mysql.createConnection({ host: '127.0.0.1', port: 23316, user: 'root', multipleStatements: false });
  try {
    const [[server]] = await connection.query('SELECT @@datadir AS datadir, @@port AS port');
    if (server.port !== 23316 || path.resolve(server.datadir).toLowerCase() !== path.resolve(expected).toLowerCase()) {
      throw new Error('Connected server is not the expected isolated MySQL instance.');
    }
    const database = `pethub_fixture_${randomBytes(8).toString('hex')}`;
    await connection.query(`CREATE DATABASE \`${database}\``);
    await connection.query(`USE \`${database}\``);
    const proposal = fs.readFileSync(path.join(__dirname, '..', '..', 'specs', 'task6-no-extraction-publication-proposed.sql'), 'utf8');
    const match = proposal.match(/ADD CONSTRAINT chk_medical_records_publication CHECK \(([\s\S]*)\)\s*;\s*$/);
    assert.ok(match, 'proposed publication check must be present');
    await connection.query(`CREATE TABLE medical_records (
      id INT PRIMARY KEY AUTO_INCREMENT,
      category_code VARCHAR(50) NOT NULL,
      document_mime_type VARCHAR(100) NOT NULL,
      extracted_document_text LONGTEXT NULL,
      extraction_status ENUM('pending','successful','failed_review_needed','image_only_reviewed','not_extracted') NOT NULL,
      publication_status ENUM('draft','published') NOT NULL,
      reviewed_by_admin_id INT NULL,
      reviewed_at TIMESTAMP NULL,
      published_at TIMESTAMP NULL,
      CONSTRAINT chk_medical_records_supported_mime_type CHECK
        (document_mime_type IN ('application/pdf','image/jpeg','image/png')),
      CONSTRAINT chk_medical_records_publication CHECK (${match[1]})
    ) ENGINE=InnoDB`);
    const configPath = require.resolve('../../config/db');
    require.cache[configPath] = {
      id: configPath, filename: configPath, loaded: true,
      exports: { promise: () => connection }, children: [], paths: []
    };
    const model = require('../../models/medicalRecordModel');
    if (!await model.supportsPublicationWithoutExtraction()) {
      const [[check]] = await connection.query("SELECT CHECK_CLAUSE AS clause FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'chk_medical_records_publication'");
      console.error('Normalized isolated check:', check.clause.replace(/_utf8mb4/gi, '').replace(/[`\s]/g, '').toLowerCase());
      throw new Error('The publication readiness gate rejected the proposed isolated CHECK.');
    }
    const insert = `INSERT INTO medical_records (category_code, document_mime_type,
      extracted_document_text, extraction_status, publication_status, reviewed_by_admin_id, reviewed_at, published_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
    const now = new Date();
    for (const category of ['x_rays_imaging', 'test_results', 'medical_history', 'immunisation_records', 'medication_history']) {
      for (const mime of ['application/pdf', 'image/jpeg', 'image/png']) {
        await connection.execute(insert, [category, mime, null, 'not_extracted', 'published', 1, now, now]);
      }
    }
    for (const values of [
      ['medication_history', 'application/pdf', null, 'not_extracted', 'published', null, now, now],
      ['medication_history', 'image/jpeg', null, 'not_extracted', 'published', 1, null, now],
      ['medical_history', 'image/png', null, 'not_extracted', 'published', 1, now, null],
      ['medical_history', 'image/png', 'old text', 'not_extracted', 'published', 1, now, now],
      ['medical_history', 'image/png', null, 'failed_review_needed', 'published', 1, now, now],
      ['medical_history', 'image/png', null, 'image_only_reviewed', 'published', 1, now, now],
      ['medical_history', 'application/octet-stream', null, 'not_extracted', 'published', 1, now, now]
    ]) {
      await assert.rejects(connection.execute(insert, values), error => error.code === 'ER_CHECK_CONSTRAINT_VIOLATED');
    }
    await connection.execute(insert, ['medical_history', 'application/pdf', 'Historical OCR text', 'successful', 'published', 1, now, now]);
    await connection.execute(insert, ['x_rays_imaging', 'image/png', null, 'image_only_reviewed', 'published', 1, now, now]);
    const [[result]] = await connection.query('SELECT COUNT(*) AS count FROM medical_records');
    assert.equal(result.count, 17);
    console.log('Isolated MySQL CHECK tests passed: 15 category/format combinations, 7 invalid cases, 2 historical cases.');
  } finally {
    await connection.end();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
