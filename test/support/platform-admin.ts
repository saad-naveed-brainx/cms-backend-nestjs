import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PlatformAdminService } from '../../src/platform-admin/platform-admin.service.js';

export type SuperAdmin = {
  email: string;
  token: string;
  headers: { Authorization: string };
};

/** A super admin made by the real command's service and signed in with the real login. */
export async function newSuperAdmin(
  app: INestApplication,
  prefix = 'ops',
): Promise<SuperAdmin> {
  const email = `${prefix}@platform.test`;
  const password = `${prefix}-platform-password`;
  await app
    .get(PlatformAdminService)
    .grant({ email, name: `Super ${prefix}`, password });
  const login = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password })
    .expect(200);
  const token = login.body.accessToken as string;
  return { email, token, headers: { Authorization: `Bearer ${token}` } };
}
