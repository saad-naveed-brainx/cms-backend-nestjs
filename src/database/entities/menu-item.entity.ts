import { Check, Column, Entity, ForeignKey, Index, Unique } from 'typeorm';
import { TimestampedEntity } from './base.entity.js';
import { Content } from './content.entity.js';
import { Menu } from './menu.entity.js';
import { Site } from './site.entity.js';

/**
 * One link in a menu, nestable. Links to an internal page by `content_id` (so renaming the page
 * never breaks the menu) or to an external `url`, never both.
 *
 * If the linked page is permanently deleted, `content_id` becomes null: the item is hidden on the
 * public site and flagged in admin — a defined state, not a broken link (GOV-03). That foreign
 * key is a plain one, not site-scoped, because `SET NULL` on a composite key would also null
 * `site_id`; the API checks the page belongs to the same site.
 */
@Entity('menu_items')
@Unique(['siteId', 'id'])
@Index(['siteId', 'menuId', 'position'])
@Index(['siteId', 'parentId'])
@Index(['contentId'])
@ForeignKey(() => Menu, ['siteId', 'menuId'], ['siteId', 'id'], {
  onDelete: 'CASCADE',
})
@ForeignKey(() => MenuItem, ['siteId', 'parentId'], ['siteId', 'id'], {
  onDelete: 'CASCADE',
})
@Check(
  'menu_items_single_target_check',
  `"content_id" IS NULL OR "url" IS NULL`,
)
export class MenuItem extends TimestampedEntity {
  @Column('uuid')
  @ForeignKey(() => Site, { onDelete: 'CASCADE' })
  siteId: string;

  @Column('uuid')
  menuId: string;

  @Column('uuid', { nullable: true })
  parentId: string | null;

  /** Order among siblings. */
  @Column('integer', { default: 0 })
  position: number;

  @Column('text')
  label: string;

  @Column('uuid', { nullable: true })
  @ForeignKey(() => Content, { onDelete: 'SET NULL' })
  contentId: string | null;

  @Column('text', { nullable: true })
  url: string | null;

  @Column('boolean', { default: false })
  openInNewTab: boolean;
}
