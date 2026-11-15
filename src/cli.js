'use strict';
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const pos = []; const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (['strict', 'json', 'include-mutating', 'allow-remote', 'github-output', 'yes', 'clear'].includes(k)) flags[k] = true; else flags[k] = argv[++i];
    } else pos.push(a);
  }
  return { pos, flags };
}

const out = (o) => process.stdout.write(JSON.stringify(o, null, 2) + '\n');

function readPolicy(raw) {
  if (raw === undefined) throw new Error('--policy is required');
  const text = raw === '-' ? fs.readFileSync(0, 'utf8') : raw.startsWith('@') ? fs.readFileSync(raw.slice(1), 'utf8') : raw;
  return JSON.parse(text);
}

function main(argv) {
  const { pos, flags } = parseArgs(argv);
  const [cmd, ...rest] = pos;
  try {
    switch (cmd) {
      case 'analyze': {
        if (!rest[0]) throw new Error('usage: route-protection-intent analyze <file> [--methods GET,POST]');
        const methods = flags.methods ? flags.methods.split(',').map((m) => m.trim().toUpperCase()) : undefined;
        out(require('./analyze').analyze(rest[0], { root: flags.root || process.cwd(), methods }));
        return 0;
      }
      case 'save': {
        if (!rest[0]) throw new Error('usage: route-protection-intent save <dir> --policy <json|@file|-> [--file <name>]');
        const r = require('./save').save(rest[0], readPolicy(flags.policy), { file: flags.file });
        const { code, ...body } = r; out(body);
        return code;
      }
      case 'check': {
        const r = require('./check').check(rest[0] || process.cwd(), { strict: !!flags.strict, base: flags.base });
        if (flags['github-output'] && process.env.GITHUB_OUTPUT) {
          const c = require('./check').countFindings(r);
          fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(c).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
        }
        if (flags.json) out(r);
        else if (flags.format === 'github') { const t = require('./check').formatGithub(r); if (t) process.stdout.write(t + '\n'); process.stdout.write(require('./check').format(r) + '\n'); }
        else process.stdout.write(require('./check').format(r) + '\n');
        return r.exitCode;
      }
      case 'report': {
        const { report, format } = require('./report');
        const r = report(path.resolve(rest[0] || process.cwd()), { strict: !!flags.strict });
        process.stdout.write(format(r, flags.format || (flags.json ? 'json' : 'table')) + '\n');
        return r.exitCode;
      }
      case 'verify': {
        const { verify, format } = require('./verify');
        return verify(path.resolve(rest[0] || process.cwd()), {
          baseUrl: flags['base-url'], includeMutating: !!flags['include-mutating'], allowRemote: !!flags['allow-remote'], strict: !!flags.strict,
          timeoutMs: flags.timeout ? Number(flags.timeout) : undefined, delayMs: flags.delay ? Number(flags.delay) : 0,
        }).then((r) => {
          process.stdout.write(format(r, flags.format || (flags.json ? 'json' : 'table')) + '\n');
          return r.exitCode;
        }).catch((e) => { out({ ok: false, error: e.message }); return 2; });
      }
      case 'spec': {
        if (!rest[0]) throw new Error('usage: route-protection-intent spec <openapi.json> [root] [--prefix /api] [--format table|md|json|csv] [--strict]');
        const { compareSpec, format } = require('./spec');
        const r = compareSpec(path.resolve(rest[1] || process.cwd()), path.resolve(rest[0]), { prefix: flags.prefix, strict: !!flags.strict });
        process.stdout.write(format(r, flags.format || (flags.json ? 'json' : 'table')) + '\n');
        return r.exitCode;
      }
      case 'set': case 'review': case 'note': case 'unset': {
        const E = require('./edit');
        const root = path.resolve(flags.root || process.cwd());
        let r;
        if (cmd === 'set') r = E.set(root, rest[0], rest[1], { methods: flags.method });
        else if (cmd === 'review') r = E.review(root, rest[0], { by: flags.by, date: flags.date });
        else if (cmd === 'note') r = E.note(root, rest[0], rest[1], { methods: flags.method, clear: !!flags.clear });
        else r = E.unset(root, rest[0], { yes: !!flags.yes });
        const { code, ...body } = r; out(body);
        return r.ok ? 0 : (code || 2);
      }
      case 'compile': {
        const r = require('./compile').compile(path.resolve(rest[0] || process.cwd()), flags.target);
        const { code, ...body } = r; out(body);
        return code;
      }
      default:
        process.stderr.write('usage: route-protection-intent <analyze|save|set|review|note|unset|check|report|verify|spec|compile> ...\n');
        return 64;
    }
  } catch (e) {
    out({ ok: false, error: e.message });
    return 2;
  }
}

module.exports = { main };
