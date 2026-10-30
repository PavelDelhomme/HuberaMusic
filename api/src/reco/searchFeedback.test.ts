import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('search feedback learning', () => {
  let dir: string;
  let recordSearchFeedback: typeof import('./searchHits.js').recordSearchFeedback;
  let resolveSearchHit: typeof import('./searchHits.js').resolveSearchHit;
  let indexLibraryTracksAsHits: typeof import('./searchHits.js').indexLibraryTracksAsHits;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ytm-search-fb-'));
    process.env.DB_PATH = join(dir, 'app.db');
    // Recharge modules avec DB isolée
    const hits = await import(`./searchHits.js?t=${Date.now()}`);
    recordSearchFeedback = hits.recordSearchFeedback;
    resolveSearchHit = hits.resolveSearchHit;
    indexLibraryTracksAsHits = hits.indexLibraryTracksAsHits;
  });

  after(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  it('apprend une faute de frappe via correct_pick', () => {
    const r = recordSearchFeedback({
      userId: 'u1',
      query: 'cayenne les amants de ta femme',
      kind: 'correct_pick',
      correctVideoId: 'XVy4kIIdmbo',
      title: 'Cayenne',
      artist: "Les Amis D'ta Femme",
    });
    assert.equal(r.ok, true);
    assert.equal(r.learned, true);
    const hit = resolveSearchHit('cayenne les amants de ta femme');
    assert.ok(hit);
    assert.equal(hit!.videoId, 'XVy4kIIdmbo');
  });

  it('indexe la biblio : titre seul → hit', () => {
    indexLibraryTracksAsHits(
      [
        {
          id: 'b_RRRKUtu20',
          title: 'Le Plus Beau',
          artists: [{ name: 'Teddy Bear' }],
        },
      ],
      'library',
    );
    const hit = resolveSearchHit('Le Plus Beau');
    assert.ok(hit);
    assert.equal(hit!.videoId, 'b_RRRKUtu20');
  });
});
