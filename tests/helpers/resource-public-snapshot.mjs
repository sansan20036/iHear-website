// Public collection response envelope only. Keep supplied records unchanged so
// defensive tests can still inject unsafe/private rows without masking them.
export function resourcePublicSnapshot({ topics, items, guidesTakeover }) {
  if (!['legacy', 'complete'].includes(guidesTakeover)) {
    throw new Error('Public Resources success fixtures require an explicit takeover state');
  }
  return { topics, items, guidesTakeover };
}

export function legacyResourceSnapshot({ topics, items }) {
  return resourcePublicSnapshot({ topics, items, guidesTakeover: 'legacy' });
}
