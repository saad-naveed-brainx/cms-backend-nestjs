import { Module } from '@nestjs/common';
import { ContentTypeRepository } from './content-type.repository.js';

/** The page types desk. Import this module to read or write page types. */
@Module({
  providers: [ContentTypeRepository],
  exports: [ContentTypeRepository],
})
export class ContentTypesModule {}
