// Round 8 (2026-11-21): two people pressing at the same moment, made so in a test. Each store given
// is wrapped; its first write (store.transaction) waits until every wrapped store has come to its
// first write, so every request has read what it reads before any of them writes. Later writes pass
// at once. A request that never comes to a write fails the waiting ones after `withinMs` instead of
// letting them pass without the gate. Test-only: nothing in the application uses it.
export function readAllBeforeWriting(stores, withinMs = 10_000) {
  let arrived = 0;
  let open;
  const allRead = new Promise(resolve => { open = resolve; });
  return stores.map(inner => {
    let first = true;
    return new Proxy(inner, {
      get(target, property) {
        const value = target[property];
        if (property !== 'transaction') return typeof value === 'function' ? value.bind(target) : value;
        return async (...args) => {
          if (first) {
            first = false;
            arrived += 1;
            if (arrived === stores.length) open();
            let timer;
            const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('readAllBeforeWriting: not every request came to its write')), withinMs); });
            try { await Promise.race([allRead, late]); } finally { clearTimeout(timer); }
          }
          return target.transaction(...args);
        };
      },
    });
  });
}
