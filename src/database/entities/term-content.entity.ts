import {
  CreateDateColumn,
  Entity,
  ForeignKey,
  Index,
  PrimaryColumn,
} from 'typeorm';
import { Content } from './content.entity.js';
import { Term } from './term.entity.js';

/**
 * Links content to its terms (many-to-many). `site_id` leads the primary key because every
 * lookup is per site anyway, and it lets both links be checked against the same site.
 */
@Entity('term_content')
@Index(['siteId', 'termId'])
@ForeignKey(() => Content, ['siteId', 'contentId'], ['siteId', 'id'], {
  onDelete: 'CASCADE',
})
@ForeignKey(() => Term, ['siteId', 'termId'], ['siteId', 'id'], {
  onDelete: 'CASCADE',
})
export class TermContent {
  @PrimaryColumn('uuid')
  siteId: string;

  @PrimaryColumn('uuid')
  contentId: string;

  @PrimaryColumn('uuid')
  termId: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
