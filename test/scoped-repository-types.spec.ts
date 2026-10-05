import type { ContentTypeRepository } from '../src/content-types/content-type.repository.js';
import type { ContentRepository } from '../src/content/content.repository.js';
import { ContentStatus } from '../src/database/entities/content.entity.js';

/**
 * Never called: it only has to compile. Each line under a `@ts-expect-error` is a call that must
 * NOT compile. If one ever does, `npm run typecheck` fails with "Unused '@ts-expect-error'
 * directive". The line just above each one is the same call written correctly, and must compile,
 * so each expected error can only come from the thing being tested.
 *
 * Keep every expected-error call on ONE line: the directive only covers the next line, and an
 * error reported further down a wrapped call would escape it.
 */
async function callsThatMustNotCompile(
  pages: ContentRepository,
  pageTypes: ContentTypeRepository,
  siteId: string,
  id: string,
): Promise<void> {
  const newPage = {
    contentTypeId: id,
    title: 'About',
    slug: 'about',
    path: '/about',
  };
  const newType = { name: 'Event', slug: 'event' };
  const drafts = { status: ContentStatus.Draft };
  const published = { status: ContentStatus.Published };

  // 1. Every desk method needs the site id as its first argument (plan D2, invariant 1).
  await pages.findById(siteId, id);
  // @ts-expect-error -- no site id
  await pages.findById(id);

  await pages.findMany(siteId);
  // @ts-expect-error -- no site id
  await pages.findMany();

  await pages.findMany(siteId, drafts);
  // @ts-expect-error -- a filter where the site id should be
  await pages.findMany(drafts);

  await pages.findByPath(siteId, '/about');
  // @ts-expect-error -- no site id
  await pages.findByPath('/about');

  await pages.findTrashed(siteId);
  // @ts-expect-error -- no site id
  await pages.findTrashed();

  await pages.create(siteId, newPage);
  // @ts-expect-error -- no site id
  await pages.create(newPage);

  await pages.update(siteId, id, { title: 'About us' });
  // @ts-expect-error -- no site id
  await pages.update(id, { title: 'About us' });

  await pageTypes.findById(siteId, id);
  // @ts-expect-error -- no site id
  await pageTypes.findById(id);

  await pageTypes.findBySlug(siteId, 'event');
  // @ts-expect-error -- no site id
  await pageTypes.findBySlug('event');

  await pageTypes.findMany(siteId);
  // @ts-expect-error -- no site id
  await pageTypes.findMany();

  await pageTypes.create(siteId, newType);
  // @ts-expect-error -- no site id
  await pageTypes.create(newType);

  await pageTypes.update(siteId, id, { name: 'Events' });
  // @ts-expect-error -- no site id
  await pageTypes.update(id, { name: 'Events' });

  // 2. A page's address cannot change through the normal update (plan D4, invariant 9): a
  //    slug, path or parent change needs the dedicated operation that also fixes descendants.
  await pages.update(siteId, id, { title: 'About us' });
  // @ts-expect-error -- slug
  await pages.update(siteId, id, { slug: 'about-us' });
  // @ts-expect-error -- path
  await pages.update(siteId, id, { path: '/about-us' });
  // @ts-expect-error -- parentId
  await pages.update(siteId, id, { parentId: id });
  // @ts-expect-error -- slug, even next to an allowed field
  await pages.update(siteId, id, { title: 'About us', slug: 'about-us' });

  // 3. A filter is one object, never an OR-array: every branch of an OR would need its own
  //    site condition, and one branch without it would match every site.
  await pages.findMany(siteId, drafts);
  // @ts-expect-error -- OR-array filter
  await pages.findMany(siteId, [drafts, published]);
  await pageTypes.findMany(siteId, { slug: 'event' });
  // @ts-expect-error -- OR-array filter
  await pageTypes.findMany(siteId, [{ slug: 'event' }, { slug: 'post' }]);

  // 4. Also from plan D2: `siteId` and `id` cannot be written into a filter, new data or a patch.
  //    (UC-SR-22, 23 and 36 cast past this on purpose to prove the runtime ignores them too.)
  // @ts-expect-error -- site id inside a filter
  await pages.findMany(siteId, { siteId });
  // @ts-expect-error -- site id inside new data
  await pages.create(siteId, { ...newPage, siteId });
  // @ts-expect-error -- id inside new data
  await pageTypes.create(siteId, { ...newType, id });
  // @ts-expect-error -- site id inside a patch
  await pages.update(siteId, id, { title: 'About us', siteId });
  // @ts-expect-error -- id inside a patch
  await pageTypes.update(siteId, id, { name: 'Events', id });
}

/**
 * UC-SR-56, never called, same rules as above: the trash date and the timestamps are managed by
 * the system, so no update patch may carry them. Trashing gets its own operation (CNT-11), and
 * TypeORM sets `createdAt` and `updatedAt`.
 */
async function systemFieldPatchesThatMustNotCompile(
  pages: ContentRepository,
  pageTypes: ContentTypeRepository,
  siteId: string,
  id: string,
): Promise<void> {
  const when = new Date();

  await pages.update(siteId, id, { title: 'About us' });
  // @ts-expect-error -- UC-SR-56: deletedAt, trashing is its own operation
  await pages.update(siteId, id, { deletedAt: when });
  // @ts-expect-error -- UC-SR-56: createdAt
  await pages.update(siteId, id, { createdAt: when });
  // @ts-expect-error -- UC-SR-56: updatedAt
  await pages.update(siteId, id, { updatedAt: when });
  // @ts-expect-error -- UC-SR-56: deletedAt, even next to an allowed field
  await pages.update(siteId, id, { title: 'About us', deletedAt: when });

  await pageTypes.update(siteId, id, { name: 'Events' });
  // @ts-expect-error -- UC-SR-56: createdAt
  await pageTypes.update(siteId, id, { createdAt: when });
  // @ts-expect-error -- UC-SR-56: updatedAt
  await pageTypes.update(siteId, id, { updatedAt: when });
}

describe('desk method signatures', () => {
  it('[UC-SR-41] a call without a site id, an address change through update, or an OR-array filter does not compile', () => {
    // The real assertions are the @ts-expect-error lines above, checked by `npm run typecheck`.
    expect(callsThatMustNotCompile).toBeTypeOf('function');
  });

  it('[UC-SR-56] an update patch carrying deletedAt, createdAt or updatedAt does not compile', () => {
    // The real assertions are the @ts-expect-error lines above, checked by `npm run typecheck`.
    expect(systemFieldPatchesThatMustNotCompile).toBeTypeOf('function');
  });
});
