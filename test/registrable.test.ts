import { describe, it, expect } from 'vitest';
import { registrableDomain } from '../src/identity/registrable.js';

describe('registrableDomain', () => {
  it('collapses subdomains of an ICANN domain to eTLD+1', () => {
    expect(registrableDomain('a.acme.com')).toBe('acme.com');
    expect(registrableDomain('b.acme.com')).toBe('acme.com');
    expect(registrableDomain('deep.nested.acme.com')).toBe('acme.com');
    expect(registrableDomain('acme.com')).toBe('acme.com');
  });

  it('handles multi-label public suffixes (co.uk)', () => {
    expect(registrableDomain('example.co.uk')).toBe('example.co.uk');
    expect(registrableDomain('x.example.co.uk')).toBe('example.co.uk');
  });

  it('treats PSL private suffixes as their own registrable unit', () => {
    // Each github.io user and each dyndns user is distinct, per the PSL PRIVATE section.
    expect(registrableDomain('user.github.io')).toBe('user.github.io');
    expect(registrableDomain('other.github.io')).toBe('other.github.io');
    expect(registrableDomain('foo.dyndns.org')).toBe('foo.dyndns.org');
  });

  it('is case- and whitespace-insensitive', () => {
    expect(registrableDomain('  A.ACME.COM ')).toBe('acme.com');
  });

  it('returns null for a bare public suffix', () => {
    expect(registrableDomain('co.uk')).toBeNull();
    expect(registrableDomain('github.io')).toBeNull();
    expect(registrableDomain('com')).toBeNull();
  });

  it('returns null for IP literals and localhost', () => {
    expect(registrableDomain('192.168.1.1')).toBeNull();
    expect(registrableDomain('127.0.0.1')).toBeNull();
    expect(registrableDomain('::1')).toBeNull();
    expect(registrableDomain('localhost')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(registrableDomain('')).toBeNull();
    expect(registrableDomain('   ')).toBeNull();
  });
});
