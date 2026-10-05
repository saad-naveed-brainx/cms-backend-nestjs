import { Module } from '@nestjs/common';
import { ContentRepository } from './content.repository.js';

/** The pages desk. Import this module to read or write pages; nothing else reaches the table. */
@Module({
  providers: [ContentRepository],
  exports: [ContentRepository],
})
export class ContentModule {}
