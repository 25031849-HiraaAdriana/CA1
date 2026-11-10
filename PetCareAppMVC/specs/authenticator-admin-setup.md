# Pomi authenticator and Admin setup

The authenticator integration uses RFC 6238 TOTP (six digits, 30-second period) and QR codes compatible with Google Authenticator and Microsoft Authenticator. User 2FA is optional; Admin 2FA is mandatory.

## Operator configuration

Keep all values in the ignored `.env` file or a secret manager. Pomi resolves `.env` relative to the application directory, regardless of the shell's current directory. Preserve the existing `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, and `DB_NAME` values.

From the `PetCareAppMVC` directory, this PowerShell procedure creates three independent secrets directly in `.env` without printing them. It updates only these keys and preserves the database settings:

```powershell
if (-not (Test-Path -LiteralPath '.env')) {
  Copy-Item '.env.example' '.env'
}

$values = [ordered]@{
  SESSION_SECRET = (& node -p "require('crypto').randomBytes(48).toString('hex')").Trim()
  POMI_2FA_ENCRYPTION_KEY = (& node -p "require('crypto').randomBytes(32).toString('base64')").Trim()
  POMI_ADMIN_SETUP_TOKEN = (& node -p "require('crypto').randomBytes(48).toString('hex')").Trim()
}
if ($values.Values | Where-Object { [string]::IsNullOrWhiteSpace($_) }) {
  throw 'Secret generation failed; .env was not updated.'
}

$lines = @(Get-Content -LiteralPath '.env' |
  Where-Object { $_ -notmatch '^(SESSION_SECRET|POMI_2FA_ENCRYPTION_KEY|POMI_ADMIN_SETUP_TOKEN)=' })
foreach ($key in $values.Keys) {
  $lines += "$key=$($values[$key])"
}
[System.IO.File]::WriteAllLines(
  (Join-Path (Get-Location) '.env'),
  $lines,
  [System.Text.UTF8Encoding]::new($false)
)
```

`SESSION_SECRET` must be at least 32 bytes. `POMI_2FA_ENCRYPTION_KEY` must decode from base64 to exactly 32 bytes. `POMI_ADMIN_SETUP_TOKEN` must be at least 32 characters.

Do not put secrets in URLs, source files, form defaults, shell output, or logs. Keep the encryption key backed up separately from MySQL; losing it makes enrolled TOTP secrets unusable. `.env` is ignored by Git.

## First Admin

1. Copy `.env.example` to `.env` if needed and configure the required secrets and database connection.
2. Review `migrations/PROPOSED_authenticator_and_admin_setup.sql` and apply it manually. The application does not execute this migration.
3. Start the application and open `/admin/setup`. Enter the operator-held setup token and create the first Admin account.
4. Scan the displayed QR code in an authenticator app and submit its current code. Save the recovery codes shown once.
5. Continue to the Admin dashboard. `/admin/setup` remains permanently disabled after setup or when the migration finds an existing Admin account.

For an existing Admin, use `/admin/login`; after password verification the application limits the pending session to authenticator enrollment until a code confirms it. Additional Admins can be provisioned from Admin accounts, with a current Admin password and unused authenticator code.

## User 2FA

Signed-in Users can open **Account security** from the navigation. Enabling or changing the authenticator requires the account password and, when already enabled, an unused current code. Disabling requires both the password and authenticator code.

The proposed SQL migration is review-only. It must be applied before the new TOTP, one-time setup, and persistent MySQL session features can be used. No live database has been changed by this implementation.

## Troubleshooting login and signup

Login and signup require a working MySQL connection and the `pomi_sessions` table,
even before credentials are submitted. If the session service cannot load or save
a session, the application reports that it is temporarily unavailable and logs
the database error code. Check the existing database configuration and MySQL
permissions without sharing credentials. A valid `SESSION_SECRET` is also
required to start the application.

The password lookup explicitly requires `users.totp_enabled` so that a missing
security column cannot silently be treated as disabled 2FA. The other TOTP
columns, recovery-code table, and Admin setup table are required for their
respective security features. Legacy SHA-256 password hashes are not changed by
the proposed migration.

To inspect the configured database without changing it, run this read-only query
after selecting the intended database:

```sql
SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, IS_NULLABLE
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME IN ('users', 'pomi_sessions', 'pomi_totp_recovery_codes', 'pomi_admin_setup_state')
ORDER BY TABLE_NAME, ORDINAL_POSITION;
```

Compare the result with the proposed migration before approving any SQL. The
proposal is not idempotent: if some objects already exist, do not blindly rerun
it. Review a schema-specific migration first, and back up the existing database.
