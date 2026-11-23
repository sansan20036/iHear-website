// The trial tools' one rule for what must not leak (W1 review, 2026-11-23). Before this module each
// tool kept its own copy, and the copies hid a query string only after http(s)://. A socket address
// (ws://, wss://) in a browser error kept its query, which can carry the video vendor's session
// credential, and the report that kept that text was never itself checked. Now:
//   - redact(): every secret and every token the run learned (`hidden`, a live Set: the tools add the
//     join answers' tokens to it as they read them) becomes [hidden], the longest first; a value shaped
//     like a JWT becomes [token]; a socket address keeps only its host; any other address keeps its
//     path but not its query or fragment; a parameter's value of 8 characters or more, anywhere in the
//     text, becomes [hidden].
//   - leaks(): a secret, plain or inside a token's base64url parts (as the tools did before).
//   - residue(): after redact(), is anything left that looks like a credential (a long parameter value,
//     a token's shape, a secret)? A report that fails it counts as found (secretsFound.reportFile).
export const TOKEN = /[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const TOKEN_SHAPE = new RegExp(TOKEN.source);
const SOCKET = /\b(wss?:\/\/[^\s"'<>/?#]+)[^\s"'<>]*/gi;
const ADDRESS = /\b([a-z][a-z0-9+.-]*:\/\/[^\s"'<>?#]+)[?#][^\s"'<>]*/gi;
// A parameter's value ends at white space, a separator, a quote, a comma or a bracket.
const PARAM = /(^|[^A-Za-z0-9_.-])([A-Za-z0-9_.-]{1,40}=)[^\s&#;,"'<>()[\]{}]{8,}/g;
const LONG_PARAM = /(^|[^A-Za-z0-9_.-])[A-Za-z0-9_.-]{1,40}=[^\s&#;,"'<>()[\]{}]{8,}/;

export function makeRedactor({ secrets = [], hidden = new Set() } = {}) {
  const known = secrets.filter(Boolean);
  const holds = text => known.some(value => String(text).includes(value));
  const leaks = text => {
    const value = String(text);
    return holds(value) || [...value.matchAll(TOKEN)].some(([token]) => token.split('.').slice(0, 2).some(part => holds(Buffer.from(part, 'base64url').toString('latin1'))));
  };
  const redact = text => {
    let out = String(text);
    for (const value of [...hidden].filter(Boolean).sort((a, b) => b.length - a.length)) out = out.split(value).join('[hidden]');
    return out.replace(TOKEN, '[token]').replace(SOCKET, '$1/[hidden]').replace(ADDRESS, '$1?[hidden]').replace(PARAM, '$1$2[hidden]');
  };
  const residue = text => {
    const value = String(text);
    return LONG_PARAM.test(value) || TOKEN_SHAPE.test(value) || leaks(value);
  };
  return { holds, leaks, redact, residue };
}
