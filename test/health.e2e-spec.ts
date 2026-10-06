import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './support/app.js';

describe('GET /health', () => {
  let app: INestApplication;

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it('[UC-SR-51] reports the API and its database as up', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);

    expect(res.body).toMatchObject({ status: 'ok', database: 'up' });
    expect(res.body.uptime).toEqual(expect.any(Number));
  });

  it('[UC-SR-53] answers an unknown URL with a 404 JSON error, not a crash', async () => {
    const res = await request(app.getHttpServer())
      .get('/no-such-endpoint')
      .expect(404);

    expect(res.body).toMatchObject({ statusCode: 404, error: 'Not Found' });
  });
});
