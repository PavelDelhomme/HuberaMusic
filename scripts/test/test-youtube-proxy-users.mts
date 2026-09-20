/**
 * Pools proxy MHC : SSRF / allowlist.
 * npx tsx scripts/test/test-youtube-proxy-users.mts
 */
import { isBlockedProxyHost, isAllowedProxyTarget } from '../../api/src/youtube/youtubeProxy.ts';

let failed = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    failed += 1;
    console.error('FAIL', msg);
  } else {
    console.log('ok ', msg);
  }
}

assert(isBlockedProxyHost('localhost'), 'localhost blocked');
assert(isBlockedProxyHost('127.0.0.1'), '127 blocked');
assert(isBlockedProxyHost('10.0.0.1'), '10/8 blocked');
assert(isBlockedProxyHost('192.168.1.1'), '192.168 blocked');
assert(isBlockedProxyHost('172.16.0.1'), '172.16 blocked');
assert(isBlockedProxyHost('169.254.169.254'), 'link-local blocked');
assert(isBlockedProxyHost('metadata.google.internal'), 'metadata blocked');
assert(isBlockedProxyHost('foo.internal'), '*.internal blocked');
assert(!isBlockedProxyHost('1.2.3.4'), '1.2.3.4 allowed as proxy host');

assert(isAllowedProxyTarget('rr1---sn-abc.googlevideo.com'), 'googlevideo allowed');
assert(isAllowedProxyTarget('www.google.com'), 'google.com allowed');
assert(isAllowedProxyTarget('genius.com'), 'genius allowed');
assert(!isAllowedProxyTarget('169.254.169.254'), '169.254 not a target');
assert(!isAllowedProxyTarget('evil.example'), 'arbitrary host not a target');

if (failed) {
  console.error(`failed=${failed}`);
  process.exit(1);
}
console.log('all ok');
