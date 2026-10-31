'use strict';
// m-2 (финальное ревью): в исходниках репозитория нет невидимых и bidi-символов (Trojan Source):
// U+200B–200F, U+202A–202E, U+2066–2069, U+FEFF. Тестам такие символы нужны — только экранами \u….
// Исключения: сторонние vendor-каталоги и ведущий BOM в .ps1 (PowerShell 5.1 читает UTF-8 по BOM).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const EXT = /\.(js|java|ps1|html|css|md)$/i;
const VENDOR = /(^|\/)(vendor|node_modules)\//;
const BAD = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  return out.split('\0').filter((f) => f && EXT.test(f) && !VENDOR.test(f));
}

test('tracked sources contain no invisible or bidi control characters', () => {
  const files = trackedFiles();
  assert.ok(files.length > 50, 'git ls-files returned the source list');
  const found = [];
  for (const f of files) {
    const abs = path.join(ROOT, f);
    if (!fs.existsSync(abs)) continue; // удалён в рабочей копии, но ещё в индексе
    let text = fs.readFileSync(abs, 'utf8');
    if (/\.ps1$/i.test(f) && text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      for (const m of line.matchAll(BAD)) {
        found.push(`${f}:${i + 1}:${m.index + 1} U+${m[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
      }
    });
  }
  assert.deepStrictEqual(found, [], 'invisible/bidi characters found:\n' + found.join('\n'));
});
