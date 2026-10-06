import { Module } from '@nestjs/common';
import { HostnameRepository } from './hostname.repository.js';

/** The addresses desk. Import this module to read a site's web addresses; nothing else reaches the table. */
@Module({
  providers: [HostnameRepository],
  exports: [HostnameRepository],
})
export class HostnamesModule {}
