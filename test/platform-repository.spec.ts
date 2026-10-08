import { PlatformRepository } from '../src/platform/platform.repository.js';

/**
 * The platform desk is the one desk without a site condition: it reads `sites`, `hostnames` and
 * `users` across every tenant, because it is asked before any site is known (invariant 1's one
 * named exception). So its surface is pinned here. A third method would be a third unscoped query.
 */
describe('the platform desk', () => {
  it('[UC-SR-26] [UC-AU-20] has exactly its five lookups: findMembershipsByUserId, findOrganizationsOwnedBy, findSiteByHostname, findUserByEmail and findUserById', () => {
    const methods = Object.getOwnPropertyNames(PlatformRepository.prototype)
      .filter((name) => name !== 'constructor')
      .sort();

    expect(
      methods,
      'PlatformRepository is the only desk that reads across sites, so every method on it is an ' +
        'unscoped query. Adding one needs a deliberate change to this test and a review. ' +
        'Every name on the class counts, private helpers included: keep those outside the class.',
    ).toEqual([
      'findMembershipsByUserId',
      'findOrganizationsOwnedBy',
      'findSiteByHostname',
      'findUserByEmail',
      'findUserById',
    ]);
  });

  it('[UC-SR-26] extends no base class, the scoped one included, so it inherits nothing beyond its own methods', () => {
    // A base class would bring its own methods (findById, create, update) that the list above
    // cannot see. The scoped base is for site-owned rows; this desk is deliberately not one.
    expect(Object.getPrototypeOf(PlatformRepository.prototype)).toBe(
      Object.prototype,
    );
  });
});
