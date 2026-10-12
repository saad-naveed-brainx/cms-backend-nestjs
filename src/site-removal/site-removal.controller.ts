import { Controller, Delete, HttpCode, Param } from '@nestjs/common';
import { CurrentUser, type AuthUser } from '../auth/decorators.js';
import { SiteRemovalService } from './site-removal.service.js';

/**
 * `DELETE /sites/:id` (D-039): like `POST /sites` it needs a sign-in and no `X-Site-Id`, because it
 * is about the organisation's owner, not about one site's members. 204 when the site is gone.
 */
@Controller('sites')
export class SiteRemovalController {
  constructor(private readonly removal: SiteRemovalService) {}

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.removal.remove(user.id, id);
  }
}
