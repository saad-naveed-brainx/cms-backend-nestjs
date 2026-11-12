import { PlatformAdminRepository } from '../src/platform-admin/platform-admin.repository.js';

/**
 * The platform-admin desk is the third place that reads across organisations (D-062), so its surface
 * is pinned here like the platform desk's. A new method is a new unscoped query: change this list on
 * purpose, with a review.
 */
describe('the platform-admin desk', () => {
  it('[UC-PA-26] has exactly its methods', () => {
    const methods = Object.getOwnPropertyNames(
      PlatformAdminRepository.prototype,
    )
      .filter((name) => name !== 'constructor')
      .sort();

    expect(
      methods,
      'Every name on the class counts, private helpers included: keep those outside the class.',
    ).toEqual([
      'acceptOwnerInvitation',
      'assignOwner',
      'createOrganization',
      'deleteOrganization',
      'findOwnerInvitationByTokenHash',
      'grantPlatformAdmin',
      'issueOwnerInvitation',
      'listOrganizations',
      'revokePlatformAdmin',
      'setSuspended',
    ]);
  });

  it('[UC-PA-26] extends no base class', () => {
    expect(Object.getPrototypeOf(PlatformAdminRepository.prototype)).toBe(
      Object.prototype,
    );
  });
});
