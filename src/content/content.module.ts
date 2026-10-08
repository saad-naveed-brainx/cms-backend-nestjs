import { Module } from '@nestjs/common';
import { ContentTypesModule } from '../content-types/content-types.module.js';
import { ContentTypesController } from './content-types.controller.js';
import { ContentController } from './content.controller.js';
import { ContentRepository } from './content.repository.js';
import { ContentService } from './content.service.js';

/**
 * The pages desk and the routes on top of it (CNT-01). Import this module to read or write pages
 * from code; nothing else reaches the table.
 */
@Module({
  imports: [ContentTypesModule],
  controllers: [ContentController, ContentTypesController],
  providers: [ContentRepository, ContentService],
  exports: [ContentRepository],
})
export class ContentModule {}
