import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Hostname } from '../database/entities/index.js';
import { ScopedRepository } from '../database/scoped.repository.js';

/**
 * The addresses desk: the web addresses a site answers on (`hostnames`), one site at a time.
 * Reading a known site's addresses is a normal scoped read. The cross-site question, "which site
 * answers on this address?", stays on the platform desk (docs/DECISIONS.md D-017).
 */
@Injectable()
export class HostnameRepository extends ScopedRepository<
  Hostname,
  'isPrimary'
> {
  constructor(dataSource: DataSource) {
    super(dataSource, Hostname);
  }
}
