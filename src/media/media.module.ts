import { Module } from '@nestjs/common';
import { MediaController, UploadsController } from './media.controller.js';
import { MediaRepository } from './media.repository.js';
import { MediaService } from './media.service.js';
import { MediaStorage } from './media-storage.js';

/** The media library (MED-01/02, D-042): uploads, the list, and the stored files. */
@Module({
  controllers: [MediaController, UploadsController],
  providers: [MediaService, MediaRepository, MediaStorage],
  exports: [MediaStorage],
})
export class MediaModule {}
