import { Module } from '@nestjs/common';
import { PreviewTokenService } from './preview-token.service.js';

/** Preview links: issued by the content routes, read by the public ones (feature site-preview). */
@Module({
  providers: [PreviewTokenService],
  exports: [PreviewTokenService],
})
export class PreviewModule {}
