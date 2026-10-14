import {
  Controller,
  Get,
  Param,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { z } from 'zod';
import {
  CurrentSite,
  CurrentUser,
  Public,
  RequirePermission,
  SiteScoped,
  type AuthUser,
  type SiteAccess,
} from '../auth/decorators.js';
import { Permission } from '../auth/permission.js';
import { parseOr400 } from '../content/content-input.js';
import { isUuid } from '../database/scoped.repository.js';
import { CONTENT_TYPES, MediaStorage, STORED_NAME } from './media-storage.js';
import { MediaService, type UploadedPicture } from './media.service.js';

/** The largest upload accepted: 10 MB. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(40),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * The site's media library (`X-Site-Id`): every member may list it; uploading needs
 * `media.upload`, checked before the file is read.
 */
@Controller('media')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Get()
  @SiteScoped()
  list(@CurrentSite() site: SiteAccess, @Query() query: unknown) {
    return this.media.list(site.siteId, parseOr400(listQuery, query));
  }

  @Post()
  @RequirePermission(Permission.MediaUpload)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
    }),
  )
  upload(
    @CurrentSite() site: SiteAccess,
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: UploadedPicture | undefined,
  ) {
    return this.media.upload(site.siteId, user.id, file);
  }
}

/**
 * The stored files, public like any picture on a website: `/uploads/<site id>/<name>`. Only names
 * the API itself writes are served, from inside that site's folder, so no other file on the disk
 * can be reached. A file never changes once written, so browsers may keep it for a year.
 */
@Controller('uploads')
export class UploadsController {
  constructor(private readonly storage: MediaStorage) {}

  @Public()
  @Get(':siteId/:name')
  file(
    @Param('siteId') siteId: string,
    @Param('name') name: string,
    @Res() res: Response,
  ): void {
    const notFound = () => {
      if (!res.headersSent) {
        res.status(404).json({ statusCode: 404, message: 'Not found' });
      }
    };
    if (!isUuid(siteId) || !STORED_NAME.test(name)) return notFound();
    const type = CONTENT_TYPES[name.slice(name.lastIndexOf('.') + 1)];
    res.sendFile(
      name,
      {
        root: `${this.storage.root}/${siteId.toLowerCase()}`,
        dotfiles: 'deny',
        maxAge: '365d',
        immutable: true,
        headers: { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff' },
      },
      (error) => {
        if (error) notFound();
      },
    );
  }
}
