import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import {
  ContentTypeRepository,
  TypeTakenError,
} from '../content-types/content-type.repository.js';
import {
  RESERVED_PREFIXES,
  slugFromName,
  type CreateTypeBody,
} from './content-type-input.js';
import { ContentRepository } from './content.repository.js';
import { toTypeView, type ContentTypeView } from './content.service.js';

const refuse = (field: string, message: string) =>
  new BadRequestException({
    message: 'Invalid request',
    errors: [`${field}: ${message}`],
  });

/**
 * Making a content type on screen (TYP-01 minimum, D-043): a name and an address, nothing else. Its
 * items are made of blocks like pages; they live at `<address>/<slug>`, and the address itself
 * lists them once one is published, with a link in the site's menu. The website and the public
 * route already treat every type with an address this way (CNT-13), so nothing is deployed.
 */
@Injectable()
export class ContentTypesService {
  constructor(
    private readonly types: ContentTypeRepository,
    private readonly pages: ContentRepository,
  ) {}

  async create(siteId: string, body: CreateTypeBody): Promise<ContentTypeView> {
    const slug = slugFromName(body.name);
    if (slug === '') throw refuse('name', 'use at least one letter or digit');
    if (RESERVED_PREFIXES.includes(body.urlPrefix)) {
      throw refuse(
        'urlPrefix',
        `${body.urlPrefix} is kept for the website itself; pick another address`,
      );
    }

    const sameName = await this.types.findBySlug(siteId, slug);
    if (sameName) {
      throw new ConflictException(
        `This site already has a content type called ${sameName.name}`,
      );
    }
    const sameAddress = await this.types.findByUrlPrefix(
      siteId,
      body.urlPrefix,
    );
    if (sameAddress) {
      throw new ConflictException(
        `${sameAddress.name} already uses ${body.urlPrefix}; pick another address`,
      );
    }
    // A page there would hide the type's list (a page someone made wins at its address).
    if (await this.pages.findByPath(siteId, body.urlPrefix)) {
      throw new ConflictException(
        `A page already uses ${body.urlPrefix}; pick another address`,
      );
    }

    try {
      const type = await this.types.create(siteId, {
        name: body.name,
        slug,
        urlPrefix: body.urlPrefix,
      });
      return toTypeView(type);
    } catch (error) {
      if (error instanceof TypeTakenError) {
        throw new ConflictException(
          'Another content type was just given this name or address; pick another',
        );
      }
      throw error;
    }
  }
}
