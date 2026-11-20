import { describe, expect, it } from 'vitest';

import { createIpAllowlist, parseCidr } from '../../src/utils/ip-allowlist.js';

describe('parseCidr', () => {
  it.each([
    ['160.79.104.0/21', { address: '160.79.104.0', prefix: 21, type: 'ipv4' }],
    ['10.0.0.1', { address: '10.0.0.1', prefix: 32, type: 'ipv4' }],
    [' 2001:db8::/32 ', { address: '2001:db8::', prefix: 32, type: 'ipv6' }],
    ['::1', { address: '::1', prefix: 128, type: 'ipv6' }],
  ])('parses %j', (entry, expected) => {
    expect(parseCidr(entry)).toEqual(expected);
  });

  it.each([
    '',
    'example.com',
    '10.0.0.0/33',
    '10.0.0.0/-1',
    '10.0.0.0/',
    '10.0.0.0/8/8',
    '10.0.0.0/1e1',
    '256.0.0.0/8',
    '2001:db8::/129',
  ])('rejects %j', (entry) => {
    expect(parseCidr(entry)).toBeNull();
  });
});

describe('createIpAllowlist', () => {
  const anthropic = createIpAllowlist(['160.79.104.0/21', '153.61.208.0/20']);

  it.each([
    ['160.79.104.0', true],
    ['160.79.111.255', true],
    ['160.79.112.0', false],
    ['153.61.223.255', true],
    ['153.61.224.0', false],
    ['::ffff:160.79.105.7', true],
    ['::ffff:127.0.0.1', false],
    ['127.0.0.1', false],
    ['2001:db8::1', false],
    ['not-an-ip', false],
    [undefined, false],
  ])('checks %j -> %s', (address, allowed) => {
    expect(anthropic.allows(address)).toBe(allowed);
  });

  it('matches IPv6 ranges', () => {
    const list = createIpAllowlist(['2001:db8::/32']);
    expect(list.allows('2001:db8:1::5')).toBe(true);
    expect(list.allows('2001:db9::5')).toBe(false);
  });

  it('allows nothing when empty', () => {
    expect(createIpAllowlist([]).allows('127.0.0.1')).toBe(false);
  });

  it('refuses invalid ranges', () => {
    expect(() => createIpAllowlist(['nope'])).toThrow('Invalid CIDR range');
  });
});
