'use strict';
// P-4: самоподписанный сертификат без openssl — PowerShell New-SelfSignedCertificate,
// экспорт в PFX (ключ) и CER (DER, для отпечатка), удаление из хранилища Windows.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const tls = require('tls');
const { spawnSync } = require('child_process');

const PS = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
try {
  $c = New-SelfSignedCertificate -Subject 'CN=claude-bridge' -KeyAlgorithm RSA -KeyLength 2048 \`
    -NotAfter (Get-Date).AddYears(10) -CertStoreLocation 'Cert:\\CurrentUser\\My' \`
    -KeyExportPolicy Exportable -KeyUsage DigitalSignature, KeyEncipherment \`
    -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.1')
  try {
    $p = ConvertTo-SecureString -String $env:CB_PFX_PASS -Force -AsPlainText
    Export-PfxCertificate -Cert $c -FilePath $env:CB_PFX -Password $p | Out-Null
    Export-Certificate -Cert $c -FilePath $env:CB_CER -Type CERT | Out-Null
  } finally {
    Remove-Item -Path ('Cert:\\CurrentUser\\My\\' + $c.Thumbprint) -DeleteKey -ErrorAction SilentlyContinue
  }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;

function files(dir, suffix = '') {
  return {
    pfx: path.join(dir, 'bridge.pfx' + suffix),
    cer: path.join(dir, 'bridge.cer' + suffix),
    pass: path.join(dir, 'bridge.pass' + suffix),
  };
}

/** Генерация во временные имена, затем атомарное переименование (нет «половинчатого» состояния). */
function generate(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = files(dir, '.tmp');
  const fin = files(dir);
  const cleanup = () => { for (const f of Object.values(tmp)) fs.rmSync(f, { force: true }); };
  cleanup();
  try {
    const pass = crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(tmp.pass, pass); // пароль на диске ДО создания PFX
    const r = spawnSync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS], {
        env: { ...process.env, CB_PFX: tmp.pfx, CB_CER: tmp.cer, CB_PFX_PASS: pass },
        encoding: 'utf8', windowsHide: true, timeout: 120000,
      });
    if (r.error) throw new Error('генерация сертификата не удалась: ' + r.error.message);
    if (r.status !== 0) throw new Error('генерация сертификата не удалась: ' + (r.stderr || r.stdout));
    if (!fs.existsSync(tmp.pfx) || !fs.existsSync(tmp.cer)) {
      throw new Error('генерация сертификата не удалась: PowerShell не создал файлы');
    }
    fs.renameSync(tmp.pass, fin.pass);
    fs.renameSync(tmp.pfx, fin.pfx);
    fs.renameSync(tmp.cer, fin.cer);
  } finally {
    cleanup();
  }
}

function load(dir) {
  const f = files(dir);
  const pfx = fs.readFileSync(f.pfx);
  const passphrase = fs.readFileSync(f.pass, 'utf8').trim();
  const ctx = tls.createSecureContext({ pfx, passphrase }); // бросит, если PFX/пароль повреждены
  const der = fs.readFileSync(f.cer);
  // .cer обязан быть тем же сертификатом, что внутри PFX: по .cer считается отпечаток для
  // пиннинга (телефон, хук, claude-mobile), а мост отвечает сертификатом из PFX.
  const probe = new tls.TLSSocket(null, { secureContext: ctx });
  let served;
  try { served = probe.getCertificate(); } finally { probe.destroy(); }
  if (!served || !served.raw || !Buffer.from(served.raw).equals(der)) {
    throw new Error('bridge.cer не совпадает с сертификатом в bridge.pfx');
  }
  return {
    tls: { pfx, passphrase },
    fingerprint: crypto.createHash('sha256').update(der).digest('hex'),
    certPem: new crypto.X509Certificate(der).toString(),
  };
}

function loadOrCreateCert(dir) {
  const f = files(dir);
  if (fs.existsSync(f.pfx) && fs.existsSync(f.cer) && fs.existsSync(f.pass)) {
    try { return load(dir); } catch (e) {
      console.error('[claude-bridge] ВНИМАНИЕ: сертификат моста повреждён (' + e.message + '). ' +
        'Создаётся новый — отпечаток изменится, ранее спаренные устройства нужно спарить заново (re-pair).');
    }
  }
  generate(dir);
  return load(dir);
}

/** TLS-опции клиента: доверять только этому сертификату (M-8). Имя хоста не проверяем — пиннинг.
 *  Клиент обязан открывать новое соединение (agent: false): иначе keep-alive переиспользует сокет
 *  без повторной проверки. */
function pinnedTlsOptions(certPem, fingerprint) {
  const want = fingerprint.toLowerCase();
  return {
    ca: certPem,
    rejectUnauthorized: true,
    checkServerIdentity: (host, cert) => {
      const got = String(cert.fingerprint256 || '').replace(/:/g, '').toLowerCase();
      return got === want ? undefined : new Error('отпечаток сертификата моста не совпадает');
    },
  };
}

module.exports = { loadOrCreateCert, pinnedTlsOptions };
