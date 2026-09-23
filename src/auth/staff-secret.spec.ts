import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveStaffSecret,
  secretFingerprint,
  staffSecret,
} from './token-verifier.service';

/**
 * ONE READER for the staff signing secret, so the boot check and the request
 * path cannot disagree about whether it is set.
 *
 * The file half exists because of an outage. The secret contained a space and
 * a `)`, which survive a quoted shell argument and do NOT survive `${VAR}`
 * interpolation into a compose file: the service came up holding a
 * wrong-but-plausible key and refused every staff token in silence. A file is
 * read as bytes, so nothing in it is special to a shell or to YAML.
 */

const dirs: string[] = [];
const secretFile = (contents: string, name = 'secret'): string => {
  const dir = mkdtempSync(join(tmpdir(), 'staff-secret-'));
  dirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, contents);
  return path;
};

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('staffSecret', () => {
  it('returns the configured secret', () => {
    expect(staffSecret('s3cret')).toBe('s3cret');
  });

  it('treats unset, empty and whitespace as NOT CONFIGURED', () => {
    // A secret of "   " would verify nothing and reject everything, which is
    // the same failure wearing a value.
    expect(staffSecret(undefined)).toBeNull();
    expect(staffSecret('')).toBeNull();
    expect(staffSecret('   ')).toBeNull();
  });
});

describe('the secret comes from a file', () => {
  it('reads it, so a Swarm secret works', () => {
    expect(staffSecret(undefined, secretFile('from-the-file'))).toBe(
      'from-the-file',
    );
  });

  it('survives the characters that compose interpolation mangles', () => {
    // The real secret from the outage: a space and a closing paren.
    const awkward = 'abcdEF GH)';
    expect(staffSecret(undefined, secretFile(awkward))).toBe(awkward);
  });

  it('strips the trailing newline `docker secret create` leaves', () => {
    expect(staffSecret(undefined, secretFile('padded\n'))).toBe('padded');
  });

  it('BEATS the environment variable when both are set', () => {
    // A leftover variable must not shadow the secret store someone chose.
    expect(staffSecret('from-env', secretFile('from-file'))).toBe('from-file');
  });
});

describe('a file that was configured but cannot be used', () => {
  it('does NOT fall back to the environment variable', () => {
    // Reading the other thing instead is how a service comes up holding the
    // wrong key and says nothing about it.
    const missing = join(tmpdir(), 'staff-secret-does-not-exist', 'nope');
    expect(staffSecret('from-env', missing)).toBeNull();
    expect(resolveStaffSecret('from-env', missing).kind).toBe(
      'file-unreadable',
    );
  });

  it('reports an empty file as unreadable, not as unset', () => {
    // Different operator mistake, different fix: the mount, not the variable.
    const source = resolveStaffSecret(undefined, secretFile(''));
    expect(source.kind).toBe('file-unreadable');
  });

  it('names the path, because the boot log has to say WHICH file', () => {
    const path = join(tmpdir(), 'staff-secret-does-not-exist', 'nope');
    const source = resolveStaffSecret(undefined, path);
    expect(source).toMatchObject({ kind: 'file-unreadable', path });
  });
});

describe('resolveStaffSecret names where it came from', () => {
  it('says env', () => {
    expect(resolveStaffSecret('s3cret', undefined)).toEqual({
      kind: 'env',
      secret: 's3cret',
    });
  });

  it('says file, with the path', () => {
    const path = secretFile('s3cret');
    expect(resolveStaffSecret(undefined, path)).toEqual({
      kind: 'file',
      path,
      secret: 's3cret',
    });
  });

  it('says unset', () => {
    expect(resolveStaffSecret(undefined, undefined)).toEqual({ kind: 'unset' });
  });

  it('treats a whitespace-only path as no path at all', () => {
    expect(resolveStaffSecret('from-env', '   ')).toEqual({
      kind: 'env',
      secret: 'from-env',
    });
  });
});

describe('secretFingerprint', () => {
  /**
   * The whole point is comparing two services without printing either secret,
   * so this has to be stable across processes and equal for equal secrets.
   */
  it('is stable, so two services can be compared', () => {
    expect(secretFingerprint('same')).toBe(secretFingerprint('same'));
  });

  it('differs for different secrets', () => {
    expect(secretFingerprint('one')).not.toBe(secretFingerprint('two'));
  });

  it('is short enough to eyeball and does not contain the secret', () => {
    const fp = secretFingerprint('abcdEF GH)');
    expect(fp).toHaveLength(12);
    expect(fp).toMatch(/^[0-9a-f]{12}$/);
    expect(fp).not.toContain('abcd');
  });

  it('matches the digest an operator computes with sha256sum', () => {
    // `printf '%s' hunter2 | sha256sum | cut -c1-12` -- the command in the
    // runbook. If this ever diverges, the runbook silently stops working.
    expect(secretFingerprint('hunter2')).toBe('f52fbd32b2b3');
  });
});
